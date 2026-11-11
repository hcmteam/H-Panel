import type { ReactNode } from 'react';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { ConfigProvider } from 'antd';
import type { ConfigProviderProps } from 'antd/es/config-provider';

// A Form.Item tooltip icon sits inside its <label>, so its "question-circle" name
// became part of every hinted field's name. FormField exposes the hint as a description.
const FORM_CONFIG: ConfigProviderProps['form'] = {
  tooltip: { icon: <QuestionCircleOutlined aria-hidden /> },
};

export function AntdRootConfig({ children }: { children: ReactNode }) {
  return <ConfigProvider form={FORM_CONFIG}>{children}</ConfigProvider>;
}
