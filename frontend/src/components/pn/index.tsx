import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Drawer, Dropdown, Modal, Switch, type MenuProps } from 'antd';

export type PlanModel = {
  id: number | string;
  name: string;
  totalGB: number;
  durationDays: number;
  limitIp: number;
  hwidLimit: number;
  trafficReset?: 'never' | 'hourly' | 'daily' | 'weekly' | 'monthly';
  startAfterFirstUse?: boolean;
  clientsCount?: number;
};
export function PnTag({ children, color = 'var(--li)' }: { children: ReactNode; color?: string }) {
  return (
    <span className="tag" style={{ '--c': color } as CSSProperties}>
      {children}
    </span>
  );
}
export function PnToggle(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Switch
      aria-label="Enabled"
      checked={props.checked}
      onChange={props.onChange}
      disabled={props.disabled}
    />
  );
}
export function PnStatTile({
  label,
  value,
  hint,
  percent = 0,
  color = 'var(--li)',
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  percent?: number;
  color?: string;
}) {
  return (
    <div
      className="card tk pn-stat"
      style={{ '--c': color, '--p': Math.min(95, Math.max(3, percent)) + '%' } as CSSProperties}
    >
      <div className="fill" />
      <div className="mu sm">{label}</div>
      <div className="big">{value}</div>
      {hint && <div className="mu xs">{hint}</div>}
    </div>
  );
}
export function PnField({
  label,
  help,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="f">
      <label>{label}</label>
      {children}
      {help && <small className="pn-help">{help}</small>}
    </div>
  );
}
export function PnSegTabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? 'on' : ''}
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
export function ResponsiveSheet({
  open,
  title,
  onClose,
  children,
  footer,
  width = 640,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 899px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 899px)');
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  if (mobile)
    return (
      <Drawer
        title={title}
        open={open}
        onClose={onClose}
        placement="bottom"
        height="100%"
        className="pn-responsive-sheet"
        footer={footer}
      >
        {children}
      </Drawer>
    );
  return (
    <Modal
      className="pn-responsive-modal"
      title={title}
      open={open}
      onCancel={onClose}
      footer={footer}
      width={width}
      centered
      destroyOnHidden
    >
      {children}
    </Modal>
  );
}
export function ActionMenu({
  items,
  children,
}: {
  items: MenuProps['items'];
  children: ReactNode;
}) {
  return (
    <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
      {children}
    </Dropdown>
  );
}
export type PlanLike = PlanModel;
export function PlanCard({
  plan,
  onClick,
  onEdit,
}: {
  plan: PlanLike;
  onClick?: () => void;
  onEdit?: () => void;
}) {
  const color = plan.clientsCount ? 'var(--gr)' : 'var(--li)';
  return (
    <article
      className="card tk pn-plan-card"
      style={{ '--c': color, '--p': '8%' } as CSSProperties}
    >
      <div className="fill" />
      <div className="r">
        <b>{plan.name}</b>
        {onClick && (
          <Button size="small" type="text" onClick={onClick}>
            Open
          </Button>
        )}
        {onEdit && (
          <Button
            size="small"
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
          >
            Edit
          </Button>
        )}
      </div>
      <div className="big">{plan.totalGB === 0 ? '∞' : String(plan.totalGB) + ' GB'}</div>
      <div className="rg">
        <PnTag>{plan.durationDays === 0 ? 'No expiry' : String(plan.durationDays) + ' days'}</PnTag>
        <PnTag>IP {plan.limitIp || '∞'}</PnTag>
      </div>
      <div className="r mu xs">
        <span>HWID {plan.hwidLimit || '∞'}</span>
        <span>{plan.clientsCount ?? 0} clients</span>
      </div>
    </article>
  );
}
export function PlanStrip({
  plans,
  activeId,
  onSelect,
}: {
  plans: PlanModel[];
  activeId?: PlanModel['id'] | null;
  onSelect: (id: PlanModel['id'] | null) => void;
}) {
  return (
    <div className="strip pn-plan-strip">
      <button
        className={'pc' + (activeId == null ? ' on' : '')}
        type="button"
        onClick={() => onSelect(null)}
      >
        All plans
      </button>
      {plans.map((plan) => (
        <button
          key={plan.id}
          className={'pc' + (activeId === plan.id ? ' on' : '')}
          type="button"
          style={{ '--c': 'var(--li)' } as CSSProperties}
          onClick={() => onSelect(plan.id)}
        >
          <b>{plan.name}</b>
          <small>
            {plan.clientsCount ?? 0} clients ·{' '}
            {plan.totalGB === 0 ? 'Unlimited' : String(plan.totalGB) + ' GB'}
          </small>
        </button>
      ))}
    </div>
  );
}
export type InboundCardModel = {
  id: number | string;
  name: string;
  protocol: string;
  port: number;
  clientCount: number;
  usedBytes: number;
  totalBytes?: number;
  enabled: boolean;
};
export function InboundCard({
  inbound,
  onEdit,
  onToggle,
  children,
}: {
  inbound: InboundCardModel;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  children?: ReactNode;
}) {
  const pct = inbound.totalBytes
    ? Math.min(95, Math.max(3, (inbound.usedBytes / inbound.totalBytes) * 100))
    : 3;
  return (
    <article
      className="card tk pn-inbound-card"
      style={{ '--c': 'var(--li)', '--p': pct + '%' } as CSSProperties}
    >
      <div className="fill" />
      <div className="r">
        <b>{inbound.name}</b>
        <Button size="small" type="text" onClick={onEdit}>
          Edit
        </Button>
        <PnToggle checked={inbound.enabled} onChange={onToggle} />
      </div>
      <div className="big">:{inbound.port}</div>
      <div className="r">
        <PnTag>{inbound.protocol}</PnTag>
        <span className="mu sm">{inbound.clientCount} clients</span>
      </div>
      {children}
    </article>
  );
}
export type ClientCardModel = {
  id: number | string;
  email: string;
  status: string;
  planName?: string;
  usedBytes: number;
  totalBytes?: number;
  expiresAt?: string;
  enabled: boolean;
};
export function ClientCard({
  client,
  onEdit,
  onToggle,
  children,
}: {
  client: ClientCardModel;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  children?: ReactNode;
}) {
  const pct = client.totalBytes
    ? Math.min(95, Math.max(3, (client.usedBytes / client.totalBytes) * 100))
    : 3;
  const color =
    client.status === 'ended'
      ? 'var(--rd)'
      : client.status === 'disabled'
        ? 'var(--mu)'
        : 'var(--gr)';
  return (
    <article
      className="card tk pn-client-card"
      style={{ '--c': color, '--p': pct + '%' } as CSSProperties}
    >
      <div className="fill" />
      <div className="r">
        <b>{client.email}</b>
        <Button size="small" type="text" onClick={onEdit}>
          Edit
        </Button>
        <PnToggle checked={client.enabled} onChange={onToggle} />
      </div>
      <div className="big">{client.totalBytes ? Math.round(pct) + '%' : '∞'}</div>
      <div className="r">
        <PnTag color={color}>{client.status}</PnTag>
        <span className="mu xs">{client.planName ?? 'No plan'}</span>
      </div>
      {client.expiresAt && <div className="mu xs">Expires {client.expiresAt}</div>}
      {children}
    </article>
  );
}
export type NavItem = { key: string; label: ReactNode; icon?: ReactNode; onClick: () => void };
export function Dock({ items, activeKey }: { items: NavItem[]; activeKey: string }) {
  return (
    <nav className="dock" aria-label="Main navigation">
      {items.map((item) => (
        <button
          key={item.key}
          className={'dk' + (activeKey === item.key ? ' on' : '')}
          onClick={item.onClick}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </nav>
  );
}
export function Rail({
  items,
  activeKey,
  logo,
}: {
  items: NavItem[];
  activeKey: string;
  logo: ReactNode;
}) {
  return (
    <nav className="rail" aria-label="Main navigation">
      <div className="logo">{logo}</div>
      {items.map((item) => (
        <button
          key={item.key}
          className={'menu' + (activeKey === item.key ? ' on' : '')}
          onClick={item.onClick}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </nav>
  );
}

export function PnPageFrame({ children }: { children: ReactNode }) {
  return <div className="pn-page-frame">{children}</div>;
}
