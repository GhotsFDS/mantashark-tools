import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// 每个测试结束清 DOM + 重置 localStorage (zustand persist 跨测试不污染)
afterEach(() => {
  cleanup();
  try { localStorage.clear(); } catch {}
});
