-- edf_windpressure.lua — 涵道风压/流速台架专用 (单点油门 + 上升/下降 ramp)
--
-- 用途: 给选定的 EDF 一个固定目标油门, 维持 N 秒, 测喷流静压/动压/流速.
--   油门曲线: 0 --(RAMP_UP ms 线性)--> THR_TGT --(HOLD_S 秒维持)--> --(RAMP_DN ms 线性)--> 0 → DONE
--   差压/流速由上位机 (windpressure_pc.py) 读 SCALED_PRESSURE.press_diff 记录;
--   本脚本广播 commanded 油门 (NAMED_VALUE_FLOAT 'WTHR') + 写 dataflash 'WPT', 供同时间轴对齐.
--
-- 触发: 上位机设好 WPT_ 参数 + WPT_EN=1 → WPT_SW_ARM 0→1 边沿 → arm_force + 跑曲线.
--        中途 WPT_SW_ARM=0 或 disarm → 立即 park 所有 motor, 回 IDLE.
--
-- 电机驱动沿用 bench_test.lua 验证过的方式: Motors_dynamic 空 factor init (过 arm health),
-- 再用 SRV_Channels:set_output_pwm_chan_timeout 强 override 选中 motor 的 PWM.
--
-- 通道 (跟 actuators.lua / bench_test.lua 一致):
--   1-4 SL1/SL2/SR1/SR2(KS)  5-6 DFL/DFR(KDF)  7-10 TL1/TL2/TR1/TR2(KT)  11-12 RDL/RDR(KRD)
-- tilt (13-21) 本脚本不驱动 — 风压测试由操作者物理对准皮托管, EDF 固定即可.

local MOTOR_PWM_OFF = 1000
local MOTOR_PWM_MAX = 2000
local PWM_HARD_MIN, PWM_HARD_MAX = 500, 2500   -- fork mantashark-rcin-extend 物理范围
local TIMEOUT_MS    = 500    -- timed override 周期 (每 tick 续写, 任务停后 ~0.5s 自动归零)

-------------------------------------------------- 参数表 WPT_ (key=86, 避开 81-85 历史占用)
local WPT = {
    { 'EN',       0    },   -- 0=禁用 (gate), 1=启用台架
    { 'MOTOR_MSK',0    },   -- bitmask, bit i (0-indexed) = motor (i+1), 1-12
    { 'THR_TGT',  0.5  },   -- 目标油门 [0,1]
    { 'HOLD_S',   5.0  },   -- 目标油门维持秒数
    { 'RAMP_UP',  2000 },   -- 0→TGT 上升 ramp 时长 ms (软启动防电流冲击, ≥2s 建议)
    { 'RAMP_DN',  1500 },   -- TGT→0 下降 ramp 时长 ms
    { 'SW_ARM',   0    },   -- 软触发: 0→1 边沿启动任务
}
assert(param:add_table(86, 'WPT_', #WPT), 'add WPT_ table fail (key=86)')
for i, p in ipairs(WPT) do
    assert(param:add_param(86, i, p[1], p[2]), 'add WPT_'..p[1])
end

-------------------------------------------------- helpers
local function clamp_pwm(p)
    if p < PWM_HARD_MIN then return PWM_HARD_MIN end
    if p > PWM_HARD_MAX then return PWM_HARD_MAX end
    return p
end

local function bit_set(mask, bit)
    return math.floor(mask / (2 ^ bit)) % 2 >= 1
end

local function motor_list_from_mask(mask)
    local list = {}
    mask = math.floor(mask or 0)
    for i = 0, 11 do
        if bit_set(mask, i) then list[#list + 1] = i + 1 end
    end
    return list
end

local _motor_list = {}   -- 当前任务选中的 motor (1-12)

local function park_motors()
    for i = 1, 12 do
        SRV_Channels:set_output_pwm_chan_timeout(i - 1, MOTOR_PWM_OFF, TIMEOUT_MS)
    end
end

local function drive_motors(thr)
    park_motors()
    if thr < 0 then thr = 0 end
    if thr > 1 then thr = 1 end
    local pwm = clamp_pwm(MOTOR_PWM_OFF + math.floor((MOTOR_PWM_MAX - MOTOR_PWM_OFF) * thr + 0.5))
    for _, m in ipairs(_motor_list) do
        SRV_Channels:set_output_pwm_chan_timeout(m - 1, pwm, TIMEOUT_MS)
    end
end

-------------------------------------------------- Motors_dynamic init (过 arm health check)
-- Q_FRAME_CLASS=17 要求 lua 注册 motor; 用空 factor table, 实际输出靠 set_output_pwm_chan_timeout override.
do
    for i = 1, 12 do
        Motors_dynamic:add_motor(i - 1, i)
    end
    local ft = motor_factor_table()
    for i = 1, 12 do
        ft:throttle(i - 1, 0); ft:roll(i - 1, 0); ft:pitch(i - 1, 0); ft:yaw(i - 1, 0)
    end
    Motors_dynamic:load_factors(ft)
    assert(Motors_dynamic:init(12), 'Motors_dynamic init failed (windpressure)')
end

-------------------------------------------------- 状态机
local STATE = { IDLE = 0, RAMP_UP = 1, HOLD = 2, RAMP_DN = 3, DONE = 4 }
local _state   = STATE.IDLE
local _thr     = 0
local _tgt     = 0
local _t0      = 0      -- 当前阶段起点 ms
local _hold_ms = 0
local _ramp_up = 0
local _ramp_dn = 0
local _done_at = 0
-- 安全: _last_sw_arm 初始 true → 必须先 0→1 边沿才能触发 (防 EEPROM 残留 SW_ARM=1 开机误触发)
local _last_sw_arm = true
local _last_log = 0
param:set('WPT_SW_ARM', 0)
gcs:send_text(6, 'WPT boot: SW_ARM reset 0 (safety)')

local function start_task(now)
    _motor_list = motor_list_from_mask(param:get('WPT_MOTOR_MSK') or 0)
    _tgt     = math.max(0, math.min(1, param:get('WPT_THR_TGT') or 0.5))
    _hold_ms = (param:get('WPT_HOLD_S') or 5) * 1000
    _ramp_up = math.max(0, param:get('WPT_RAMP_UP') or 2000)
    _ramp_dn = math.max(0, param:get('WPT_RAMP_DN') or 1500)
    _thr     = 0
    _t0      = now
    _state   = STATE.RAMP_UP
    drive_motors(0)
    gcs:send_text(6, string.format('WPT START motors=%d tgt=%.0f%% ramp_up=%dms hold=%.1fs ramp_dn=%dms',
        #_motor_list, _tgt * 100, _ramp_up, _hold_ms / 1000, _ramp_dn))
end

local function abort_task(reason)
    park_motors()
    _state = STATE.IDLE
    gcs:send_text(4, 'WPT ABORT: ' .. tostring(reason))
end

local function step_task(now)
    if _state == STATE.RAMP_UP then
        local e = now - _t0
        if _ramp_up <= 0 or e >= _ramp_up then
            _thr = _tgt; _state = STATE.HOLD; _t0 = now
            gcs:send_text(6, string.format('WPT HOLD %.0f%% for %.1fs', _tgt * 100, _hold_ms / 1000))
        else
            _thr = _tgt * e / _ramp_up
        end
        drive_motors(_thr)
    elseif _state == STATE.HOLD then
        _thr = _tgt
        drive_motors(_thr)
        if now - _t0 >= _hold_ms then
            _state = STATE.RAMP_DN; _t0 = now
            gcs:send_text(6, string.format('WPT RAMP_DN %.0f%%->0 over %dms', _tgt * 100, _ramp_dn))
        end
    elseif _state == STATE.RAMP_DN then
        local e = now - _t0
        if _ramp_dn <= 0 or e >= _ramp_dn then
            _thr = 0; park_motors(); _state = STATE.DONE; _done_at = now
            gcs:send_text(6, 'WPT DONE - auto reset in 500ms')
        else
            _thr = _tgt * (1.0 - e / _ramp_dn)
            drive_motors(_thr)
        end
    end
end

-------------------------------------------------- 主循环 50Hz
local function update()
    local now      = millis():tofloat()
    local hw_armed = arming:is_armed()
    local sw_arm   = (param:get('WPT_SW_ARM') or 0) >= 0.5
    local en       = (param:get('WPT_EN') or 0) >= 0.5

    local edge_up   = sw_arm and not _last_sw_arm
    local edge_down = (not sw_arm) and _last_sw_arm
    _last_sw_arm = sw_arm

    -- 触发
    if edge_up then
        if not hw_armed then
            local ok = arming:arm_force()
            gcs:send_text(6, 'WPT SW_ARM up: arm_force()=' .. tostring(ok))
        end
        if en and _state == STATE.IDLE then
            start_task(now)
        else
            gcs:send_text(6, string.format('WPT arm-up IGN: en=%s state=%d', tostring(en), _state))
        end
    end
    if edge_down then
        if _state ~= STATE.IDLE and _state ~= STATE.DONE then abort_task('SW_ARM=0') end
        if hw_armed then arming:disarm() end
    end

    -- disarm 中途保护
    if not hw_armed and not sw_arm and (_state == STATE.RAMP_UP or _state == STATE.HOLD or _state == STATE.RAMP_DN) then
        abort_task('disarmed')
    end

    -- 推进
    if (hw_armed or sw_arm) and (_state == STATE.RAMP_UP or _state == STATE.HOLD or _state == STATE.RAMP_DN) then
        step_task(now)
    elseif _state == STATE.DONE then
        park_motors()
        if now - _done_at > 500 then
            if hw_armed then arming:disarm() end
            _state = STATE.IDLE
            gcs:send_text(6, 'WPT IDLE (auto-reset)')
        end
    else
        park_motors()
    end

    -- 广播 commanded 油门 + airspeed 参考, 写 dataflash (供上位机/log 同步)
    gcs:send_named_float('WTHR', _thr)
    gcs:send_named_float('WST', _state)
    local asp = ahrs:airspeed_estimate() or 0
    logger:write('WPT', 'thr,asp,st', 'ffB', _thr, asp, _state)

    -- 1Hz 心跳
    if now - _last_log > 1000 then
        _last_log = now
        local st = ({ [0] = 'IDLE', [1] = 'RAMP_UP', [2] = 'HOLD', [3] = 'RAMP_DN', [4] = 'DONE' })[_state] or '?'
        gcs:send_text(6, string.format('WPT %s thr=%.0f%% (en=%s)', st, _thr * 100, en and '1' or '0'))
    end

    return update, 20   -- 50Hz
end

gcs:send_text(6, 'edf_windpressure.lua loaded')
return update, 200
