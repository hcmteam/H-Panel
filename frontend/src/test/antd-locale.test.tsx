import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('AntdRootConfig English locale', () => {
  afterEach(() => {
    document.cookie = 'lang=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('keeps Ant Design text in English when a non-English cookie is saved', async () => {
    vi.resetModules();
    document.cookie = 'lang=fa-IR; path=/';
    const { readyI18n } = await import('@/i18n/react');
    const { AntdRootConfig } = await import('@/i18n/AntdRootConfig');
    const { Empty } = await import('antd');

    await readyI18n('panel');
    render(
      <AntdRootConfig>
        <Empty />
      </AntdRootConfig>,
    );

    expect(document.querySelector('.ant-empty-description')?.textContent).toBe('No data');
    expect(document.cookie).toContain('lang=en-US');
  });
});
