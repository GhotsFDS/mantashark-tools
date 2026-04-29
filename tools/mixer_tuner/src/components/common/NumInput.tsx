// 通用数字输入: onBlur/Enter/↑↓ 才 push, 防字符级触发让 FC 突变 + 浪费数传链路
// 配合 focus race lock — 用户编辑期间外部 value 变化不覆盖 draft
import React from 'react';

interface Props {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  disabled?: boolean;
  // clamp=true (默认): 超出范围 clamp 到 min/max 再 push, flash bad
  // clamp=false: 拒绝 + 还原 + flash bad
  clamp?: boolean;
  // 显示精度 (toString 默认对小数有问题, 例如 0.1+0.2=0.30000004)
  decimals?: number;
}

const fmt = (v: number, decimals?: number) =>
  decimals !== undefined ? Number(v).toFixed(decimals) : String(v);

export function NumInput({ value, onCommit, min, max, step = 0.01, className = '', disabled, clamp = true, decimals }: Props) {
  const focusedRef = React.useRef(false);
  const [draft, setDraft] = React.useState(fmt(value, decimals));
  const [flash, setFlash] = React.useState<'ok' | 'bad' | null>(null);

  React.useEffect(() => { if (!focusedRef.current) setDraft(fmt(value, decimals)); }, [value, decimals]);

  const commit = () => {
    const n = parseFloat(draft);
    if (isNaN(n)) {
      setDraft(fmt(value, decimals));
      setFlash('bad'); setTimeout(() => setFlash(null), 400);
      return;
    }
    let v = n;
    if (clamp) {
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      if (v !== n) {
        setDraft(fmt(v, decimals));
        setFlash('bad'); setTimeout(() => setFlash(null), 400);
      }
    } else if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
      setDraft(fmt(value, decimals));
      setFlash('bad'); setTimeout(() => setFlash(null), 400);
      return;
    }
    if (v !== value) {
      onCommit(v);
      setFlash('ok'); setTimeout(() => setFlash(null), 250);
    }
  };

  const ringCls = flash === 'bad' ? 'ring-1 ring-warn rounded' :
                  flash === 'ok'  ? 'ring-1 ring-accent rounded' : '';

  return (
    <input type="number" step={step} min={min} max={max} inputMode="decimal"
           disabled={disabled}
           value={draft}
           onChange={e => setDraft(e.target.value)}
           onFocus={() => { focusedRef.current = true; }}
           onBlur={() => { focusedRef.current = false; commit(); }}
           onKeyDown={e => {
             if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
             else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') setTimeout(commit, 0);
           }}
           className={`${className} transition-all ${ringCls}`} />
  );
}
