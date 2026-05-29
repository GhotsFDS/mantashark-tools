import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NumInput } from '../components/common/NumInput';
import React from 'react';

describe('NumInput', () => {
  it('打字过程中不触发 onCommit, 失焦才推', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<NumInput value={1500} min={500} max={2500} step={1} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    await user.click(input);
    await user.tripleClick(input);
    await user.keyboard('1234');                  // 字符级输入不应推
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.blur(input);                         // 失焦才推
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(1234);
  });

  it('回车 = 失焦 + commit', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<NumInput value={10} min={0} max={100} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    await user.click(input);
    await user.tripleClick(input);
    await user.keyboard('42');
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith(42);
  });

  it('clamp 模式: 超 max 截断到 max + 推', () => {
    const onCommit = vi.fn();
    render(<NumInput value={50} min={0} max={100} clamp onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(100);
  });

  it('clamp 模式: 低于 min 截断到 min + 推', () => {
    const onCommit = vi.fn();
    render(<NumInput value={50} min={10} max={100} clamp onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(10);
  });

  it('clamp=false 模式: 超出范围拒绝, 不调 onCommit, 还原 value', () => {
    const onCommit = vi.fn();
    render(<NumInput value={50} min={0} max={100} clamp={false} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('50.00');  // 默认 step=0.01 → auto decimals=2
  });

  it('NaN 输入: 拒绝, 还原, 不推', () => {
    const onCommit = vi.fn();
    render(<NumInput value={42} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('值未变 (打回原值): 不重复推', () => {
    const onCommit = vi.fn();
    render(<NumInput value={100} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('focus race lock: 编辑期间外部 value 改变不覆盖 draft', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const { rerender } = render(<NumInput value={1500} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    await user.click(input);                       // 用户聚焦开始编辑
    await user.tripleClick(input);
    await user.keyboard('99');                     // draft = "99"
    expect(input.value).toBe('99');

    rerender(<NumInput value={1502} onCommit={onCommit} />);  // 模拟 GCS 推 PARAM_VALUE
    expect(input.value).toBe('99');                // 用户输入未被覆盖

    fireEvent.blur(input);                          // blur 后才 commit
    expect(onCommit).toHaveBeenCalledWith(99);
  });

  it('未聚焦时外部 value 变化立刻同步 draft', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<NumInput value={1500} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    rerender(<NumInput value={2000} onCommit={onCommit} />);
    expect(input.value).toBe('2000.00');  // 默认 step=0.01 → auto decimals=2
  });

  it.each([
    [1,     5,     '5'],       // 整数
    [0.5,   3.1,   '3.1'],     // 1 位
    [0.1,   3.1,   '3.1'],     // 1 位
    [0.05,  0.25,  '0.25'],    // 2 位
    [0.01,  0.27,  '0.27'],    // 2 位 (整数边界, 修过 1e-9 bug)
    [0.001, 0.012, '0.012'],   // 3 位
  ])('step=%s value=%s 显示 %s 位 (auto decimals)', (step, value, expected) => {
    render(<NumInput value={value} step={step} onCommit={() => {}} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(input.value).toBe(expected);
  });

  it('mavlink float32 round-trip noise: 3.0999999 显示 "3.1" (step=0.5)', () => {
    render(<NumInput value={3.0999999046325684} step={0.5} onCommit={() => {}} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(input.value).toBe('3.1');
  });

  it('箭头键 ↑↓ 触发 commit (jsdom 不实现 native step, 模拟 draft 已变)', async () => {
    const onCommit = vi.fn();
    render(<NumInput value={10} min={0} max={100} step={1} onCommit={onCommit} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '11' } });   // 模拟浏览器 step 后值
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await new Promise(r => setTimeout(r, 10));               // setTimeout(commit, 0) 异步
    expect(onCommit).toHaveBeenCalledWith(11);
  });
});
