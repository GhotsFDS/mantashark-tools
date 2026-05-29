import React, { useEffect, useRef, useState } from 'react';

interface Props {
  designW: number;        // 逻辑画布宽 (px), 比如 1860
  designH: number;        // 逻辑画布高 (px), 比如 980
  children: React.ReactNode;
  background?: string;    // 可选背景, 默认透明 (继承外层 bg)
}

/**
 * 等比缩放画布. 内部以 designW × designH 像素布局 (绝对定位),
 * 外层根据视口实际尺寸用 transform: scale() 等比缩.
 *
 * 优点: 子组件用 px 精确布局, 与视口分辨率解耦, 不依赖 grid auto-flow.
 * 缩放策略: 取 min(viewW/designW, viewH/designH) 保证全画布可见 (letterbox).
 *
 * 子内容应用 absolute 定位. 也兼容 grid/flex (按 designW 宽度作 layout 即可).
 */
export function ScaledCanvas({ designW, designH, children, background }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [centerOffset, setCenterOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      // 用 min 保证 letterbox + 占满: 16:9 画布在 16:9 屏完美贴边, 不规则屏小边贴边大边居中
      const sx = r.width / designW;
      const sy = r.height / designH;
      const s = Math.min(sx, sy, 2.0);   // 最大 2x 放大 (4K 屏放 1080 画布到 2160 看清)
      setScale(s);
      setCenterOffset({
        x: (r.width  - designW * s) / 2,
        y: (r.height - designH * s) / 2,
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [designW, designH]);

  return (
    <div ref={wrapRef} style={{
      width: '100%', height: '100%', overflow: 'hidden',
      background: background ?? 'transparent',
      position: 'relative',
    }}>
      <div style={{
        width: designW, height: designH,
        position: 'absolute',
        left: centerOffset.x,
        top:  centerOffset.y,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
      }}>
        {children}
      </div>
    </div>
  );
}
