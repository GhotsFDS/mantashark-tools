-- motor_test.lua — 电机油门阶梯扫描台架 (配 motor_test_gui.py)
--
-- 油门曲线: 0 --(RAMP_UP ms 缓升)--> THR_MIN --(每档 HOLD_MS 维持, +THR_STEP 阶进)--> THR_MAX
--           --(RAMP_DN ms 缓降)--> 0 → DONE
--   每档广播 commanded 油门 (NAMED_VALUE_FLOAT 'MTHR') + 状态 'MST', 上位机配 BATTERY_STATUS 读 V/I.
--
-- 触发: 上位机设 MTT_ 参数 + MTT_EN=1 → MTT_SW_ARM 0→1 边沿 → arm_force + 跑阶梯.
--        中途 MTT_SW_ARM=0 / disarm → 立即 park 所有 motor, 回 IDLE.
--
-- 电机驱动沿用验证过的方式: Motors_dynamic 空 factor init (过 arm health) + set_output_pwm_chan_timeout override.
-- 通道: 1-4 SL1/SL2/SR1/SR2  5-6 DFL/DFR  7-10 TL1/TL2/TR1/TR2  11-12 RDL/RDR

local MOTOR_PWM_OFF = 1000
local MOTOR_PWM_MAX = 2000
local PWM_HARD_MIN, PWM_HARD_MAX = 500, 2500
local TIMEOUT_MS    = 500

-------------------------------------------------- 参数表 MTT_ (key=87, 避开 81-86)
local MTT = {
    { 'EN',       0    },   -- 0=禁用 gate, 1=启用
    { 'MOTOR_MSK',0    },   -- bitmask, bit i = motor (i+1), 1-12
    { 'THR_MIN',  0.1  },   -- 起始油门 [0,1]
    { 'THR_MAX',  1.0  },   -- 终止油门 [0,1]
    { 'THR_STEP', 0.1  },   -- 阶进步长
    { 'HOLD_MS',  2000 },   -- 每档维持 ms
    { 'RAMP_UP',  2000 },   -- 0→THR_MIN 缓升 ms
    { 'RAMP_DN',  1500 },   -- THR_MAX→0 缓降 ms
    { 'SW_ARM',   0    },   -- 软触发 0→1 边沿
}
assert(param:add_table(87, 'MTT_', #MTT), 'add MTT_ table fail (key=87)')
for i, p in ipairs(MTT) do
    assert(param:add_param(87, i, p[1], p[2]), 'add MTT_'..p[1])
end

-------------------------------------------------- helpers
local function clamp_pwm(p)
    if p < PWM_HARD_MIN then return PWM_HARD_MIN end
    if p > PWM_HARD_MAX then return PWM_HARD_MAX end
    return p
end
local function bit_set(mask, bit) return math.floor(mask / (2 ^ bit)) % 2 >= 1 end
local function motor_list_from_mask(mask)
    local list = {}; mask = math.floor(mask or 0)
    for i = 0, 11 do if bit_set(mask, i) then list[#list + 1] = i + 1 end end
    return list
end

local _motor_list = {}
local function park_motors()
    for i = 1, 12 do SRV_Channels:set_output_pwm_chan_timeout(i - 1, MOTOR_PWM_OFF, TIMEOUT_MS) end
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

-------------------------------------------------- Motors_dynamic init (过 arm health)
do
    for i = 1, 12 do Motors_dynamic:add_motor(i - 1, i) end
    local ft = motor_factor_table()
    for i = 1, 12 do ft:throttle(i-1,0); ft:roll(i-1,0); ft:pitch(i-1,0); ft:yaw(i-1,0) end
    Motors_dynamic:load_factors(ft)
    assert(Motors_dynamic:init(12), 'Motors_dynamic init failed (motor_test)')
end

-------------------------------------------------- 状态机
local STATE = { IDLE=0, RAMP_UP=1, HOLD=2, RAMP_DN=3, DONE=4 }
local _state = STATE.IDLE
local _thr = 0
local _min, _max, _step = 0.1, 1.0, 0.1
local _hold_ms, _ramp_up, _ramp_dn = 2000, 2000, 1500
local _t0 = 0
local _done_at = 0
local _last_sw_arm = true
local _last_log = 0
param:set('MTT_SW_ARM', 0)
gcs:send_text(6, 'MTT boot: SW_ARM reset 0 (safety)')

local function start_task(now)
    _motor_list = motor_list_from_mask(param:get('MTT_MOTOR_MSK') or 0)
    _min  = math.max(0, math.min(1, param:get('MTT_THR_MIN') or 0.1))
    _max  = math.max(_min, math.min(1, param:get('MTT_THR_MAX') or 1.0))
    _step = math.max(0.01, param:get('MTT_THR_STEP') or 0.1)
    _hold_ms = param:get('MTT_HOLD_MS') or 2000
    _ramp_up = math.max(0, param:get('MTT_RAMP_UP') or 2000)
    _ramp_dn = math.max(0, param:get('MTT_RAMP_DN') or 1500)
    _thr = 0; _t0 = now; _state = STATE.RAMP_UP
    drive_motors(0)
    gcs:send_text(6, string.format('MTT START motors=%d %.0f->%.0f%% step%.0f%% ramp_up=%dms hold=%dms',
        #_motor_list, _min*100, _max*100, _step*100, _ramp_up, _hold_ms))
end

local function abort_task(reason)
    park_motors(); _state = STATE.IDLE
    gcs:send_text(4, 'MTT ABORT: '..tostring(reason))
end

local function step_task(now)
    if _state == STATE.RAMP_UP then
        local e = now - _t0
        if _ramp_up <= 0 or e >= _ramp_up then
            _thr = _min; _state = STATE.HOLD; _t0 = now
            gcs:send_text(6, string.format('MTT HOLD %.0f%%', _thr*100))
        else
            _thr = _min * e / _ramp_up
        end
        drive_motors(_thr)
    elseif _state == STATE.HOLD then
        drive_motors(_thr)
        if now - _t0 >= _hold_ms then
            local nxt = _thr + _step
            if nxt > _max + 1e-6 then
                _state = STATE.RAMP_DN; _t0 = now
                gcs:send_text(6, string.format('MTT RAMP_DN %.0f%%->0', _thr*100))
            else
                _thr = nxt; _t0 = now
                gcs:send_text(6, string.format('MTT HOLD %.0f%%', _thr*100))
            end
        end
    elseif _state == STATE.RAMP_DN then
        local e = now - _t0
        if _ramp_dn <= 0 or e >= _ramp_dn then
            _thr = 0; park_motors(); _state = STATE.DONE; _done_at = now
            gcs:send_text(6, 'MTT DONE')
        else
            _thr = _max * (1.0 - e / _ramp_dn)
            drive_motors(_thr)
        end
    end
end

-------------------------------------------------- 主循环 50Hz
local function update()
    local now = millis():tofloat()
    local hw_armed = arming:is_armed()
    local sw_arm = (param:get('MTT_SW_ARM') or 0) >= 0.5
    local en = (param:get('MTT_EN') or 0) >= 0.5
    local edge_up = sw_arm and not _last_sw_arm
    local edge_down = (not sw_arm) and _last_sw_arm
    _last_sw_arm = sw_arm

    if edge_up then
        if not hw_armed then
            gcs:send_text(6, 'MTT SW_ARM up: arm_force()='..tostring(arming:arm_force()))
        end
        if en and _state == STATE.IDLE then start_task(now)
        else gcs:send_text(6, string.format('MTT arm-up IGN: en=%s state=%d', tostring(en), _state)) end
    end
    if edge_down then
        if _state ~= STATE.IDLE and _state ~= STATE.DONE then abort_task('SW_ARM=0') end
        if hw_armed then arming:disarm() end
    end
    if not hw_armed and not sw_arm and (_state==STATE.RAMP_UP or _state==STATE.HOLD or _state==STATE.RAMP_DN) then
        abort_task('disarmed')
    end

    if (hw_armed or sw_arm) and (_state==STATE.RAMP_UP or _state==STATE.HOLD or _state==STATE.RAMP_DN) then
        step_task(now)
    elseif _state == STATE.DONE then
        park_motors()
        if now - _done_at > 500 then
            if hw_armed then arming:disarm() end
            _state = STATE.IDLE
            gcs:send_text(6, 'MTT IDLE (auto-reset)')
        end
    else
        park_motors()
    end

    gcs:send_named_float('MTHR', _thr)
    gcs:send_named_float('MST', _state)

    if now - _last_log > 1000 then
        _last_log = now
        local st = ({[0]='IDLE',[1]='RAMP_UP',[2]='HOLD',[3]='RAMP_DN',[4]='DONE'})[_state] or '?'
        gcs:send_text(6, string.format('MTT %s thr=%.0f%% (en=%s)', st, _thr*100, en and '1' or '0'))
    end
    return update, 20
end

gcs:send_text(6, 'motor_test.lua loaded')
return update, 200
