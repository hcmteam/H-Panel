import { useEffect, useMemo, useState } from 'react';
import { Layout } from 'antd';
import AppSidebar from '@/layouts/AppSidebar';
import {
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tabs,
  Typography,
  message,
  Popconfirm,
} from 'antd';
import { useTranslation } from 'react-i18next';
import { DeleteOutlined } from '@ant-design/icons';
import { PlanCard, PnStatTile, ResponsiveSheet, type PlanModel } from '@/components/pn';
import { clientManagementPath } from '@/api/client-management';
import { ClientHydrateSchema } from '@/schemas/client';
import { SlimInboundListSchema } from '@/schemas/inbound';
import { HttpUtil, RandomUtil } from '@/utils';
import { parseMsg } from '@/utils/zodValidate';
import { selectTagRender } from '@/components/form';
import ClientFormModal from '@/pages/clients/ClientFormModal';
import { useClients } from '@/hooks/useClients';

type PlanDraft = Omit<PlanModel, 'id' | 'clientsCount'> & { applyToExistingClients?: boolean };
type ClientDraft = {
  email: string;
  planId: number | string;
  telegramId?: string;
  group?: string;
  inbounds?: number[];
};
type PlanInbound = {
  id: number;
  protocol: string;
  tag?: string;
  remark?: string;
  enable?: boolean;
};

const EMPTY_PLAN: PlanDraft = {
  name: '',
  totalGB: 0,
  durationDays: 0,
  limitIp: 0,
  hwidLimit: 0,
  trafficReset: 'never',
  startAfterFirstUse: false,
  applyToExistingClients: false,
};

let nextPlanDraftId = 1;
const PLAN_STORAGE_KEY = 'hpanel.plans.v1';
const PLAN_CLIENT_STORAGE_KEY = 'hpanel.plan-clients.v1';
function readStored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

const applyPlanToClient = async (
  plan: PlanModel,
  email: string,
  inboundIds: number[],
  clientDetails: Pick<ClientDraft, 'telegramId' | 'group'> = {},
): Promise<void> => {
  const raw = await HttpUtil.get(clientManagementPath('get', email));
  const hydrated = parseMsg(raw, ClientHydrateSchema, 'clients/get');
  if (!hydrated?.success || !hydrated.obj?.client) {
    throw new Error(
      hydrated?.msg || `Client ${email} not found. Create it on the Clients page first.`,
    );
  }

  const client = hydrated.obj.client;
  const updatedClient = {
    ...client,
    totalGB: Math.round(Math.max(0, Number(plan.totalGB) || 0) * 1024 ** 3),
    expiryTime: plan.durationDays > 0 ? Date.now() + plan.durationDays * 24 * 60 * 60 * 1000 : 0,
    limitIp: Math.max(0, Number(plan.limitIp) || 0),
    limitHwid: Math.max(0, Number(plan.hwidLimit) || 0),
    trafficReset: plan.trafficReset || 'never',
    tgId: clientDetails.telegramId?.trim()
      ? Number(clientDetails.telegramId) || client.tgId
      : client.tgId,
    group: clientDetails.group?.trim() || client.group,
  };
  const result = await HttpUtil.post(clientManagementPath('update', email), updatedClient, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!result?.success) {
    throw new Error(result?.msg || 'Could not apply the plan to ' + email + '.');
  }

  const currentInboundIds = Array.isArray(hydrated.obj.inboundIds) ? hydrated.obj.inboundIds : [];
  const inboundsToAttach = inboundIds.filter((id) => !currentInboundIds.includes(id));
  if (inboundsToAttach.length) {
    const attached = await HttpUtil.post(
      `/panel/api/clients/${encodeURIComponent(email)}/attach`,
      { inboundIds: inboundsToAttach },
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (!attached?.success) {
      throw new Error(
        attached?.msg || 'Plan limits were saved, but the inbound could not be attached.',
      );
    }
  }
};

function PlansPageContent() {
  const { t } = useTranslation();
  const label = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const { inbounds: clientInbounds, tgBotEnable, create: createClient } = useClients();
  const [messageApi, messageContextHolder] = message.useMessage();

  const [plans, setPlans] = useState<PlanModel[]>(() => {
    const stored = readStored<PlanModel[]>(PLAN_STORAGE_KEY, []);
    const ids = stored.map((plan) => Number(plan.id)).filter(Number.isFinite);
    if (ids.length) nextPlanDraftId = Math.max(nextPlanDraftId, ...ids.map((id) => id + 1));
    return stored;
  });
  const [linkedClients, setLinkedClients] = useState<(ClientDraft & { id: string })[]>(() => {
    const stored = readStored<unknown>(PLAN_CLIENT_STORAGE_KEY, []);
    return Array.isArray(stored) ? (stored as (ClientDraft & { id: string })[]) : [];
  });
  const [planConfigLoaded, setPlanConfigLoaded] = useState(false);
  const [inbounds, setInbounds] = useState<PlanInbound[]>([]);
  const [inboundsLoading, setInboundsLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void HttpUtil.get('/panel/api/inbounds/list/slim', undefined, { silent: true })
      .then((response) => {
        if (!response?.success) throw new Error(response?.msg || 'Could not load inbounds.');
        const parsed = parseMsg(response, SlimInboundListSchema, 'inbounds/list/slim');
        if (!active) return;
        setInbounds(
          (parsed.obj ?? []).map((item) => ({
            id: item.id,
            protocol: item.protocol,
            tag: typeof item.tag === 'string' ? item.tag : '',
            remark: typeof item.remark === 'string' ? item.remark : '',
            enable: item.enable !== false,
          })),
        );
      })
      .catch((error) => {
        if (active) {
          messageApi.error(error instanceof Error ? error.message : 'Could not load inbounds.');
        }
      })
      .finally(() => {
        if (active) setInboundsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [messageApi]);
  useEffect(() => {
    let active = true;
    const loadPlanConfig = async () => {
      try {
        const response = await HttpUtil.get(clientManagementPath('planConfig', '..'));
        const config = response?.obj as
          | { plans?: PlanModel[]; clients?: typeof linkedClients; configured?: boolean }
          | undefined;
        if (active && response?.success && config?.configured) {
          setPlans(Array.isArray(config.plans) ? config.plans : []);
          setLinkedClients(Array.isArray(config.clients) ? config.clients : []);
        }
      } catch {
        /* Keep the local copy available if the server is temporarily unreachable. */
      } finally {
        if (active) setPlanConfigLoaded(true);
      }
    };
    void loadPlanConfig();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!planConfigLoaded) return;
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plans));
    localStorage.setItem(PLAN_CLIENT_STORAGE_KEY, JSON.stringify(linkedClients));
    const timer = window.setTimeout(() => {
      void HttpUtil.post(
        clientManagementPath('planConfig', '..'),
        { plans, clients: linkedClients },
        { headers: { 'Content-Type': 'application/json' } },
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [plans, linkedClients, planConfigLoaded]);
  const [selectedPlan, setSelectedPlan] = useState<PlanModel | null>(null);
  const [editor, setEditor] = useState<'create' | 'edit' | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [clientOpen, setClientOpen] = useState(false);
  const [newClientOpen, setNewClientOpen] = useState(false);
  const [clientSubmitting, setClientSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<'clients' | 'keys'>('clients');
  const [form] = Form.useForm<PlanDraft>();
  const [clientForm] = Form.useForm<ClientDraft>();
  const clients = useMemo(() => linkedClients.length, [linkedClients]);
  const createNewPlanClient = async (
    payload: Record<string, unknown> | { client: Record<string, unknown>; inboundIds: number[] },
    meta:
      | { isEdit: false; email: string; externalLinks: unknown[] }
      | {
          isEdit: true;
          email: string;
          attach: number[];
          detach: number[];
          externalLinks: unknown[];
        },
  ) => {
    if (!selectedPlan || meta.isEdit) return null;
    const email = meta.email.trim();
    const created = await createClient(payload);
    if (!created?.success) return created;
    const inboundIds =
      'inboundIds' in payload && Array.isArray(payload.inboundIds) ? payload.inboundIds : [];
    try {
      await applyPlanToClient(selectedPlan, email, inboundIds);
      const clientRecord: Record<string, unknown> =
        'client' in payload && payload.client && typeof payload.client === 'object'
          ? (payload.client as Record<string, unknown>)
          : payload;
      const telegramId = String(clientRecord.tgId ?? '');
      const group = String(clientRecord.group ?? '');
      const linked = {
        email,
        planId: selectedPlan.id,
        telegramId,
        group,
        inbounds: inboundIds,
        id: RandomUtil.randomUUID(),
      };
      setLinkedClients((current) => [...current, linked]);
      setPlans((current) =>
        current.map((item) =>
          String(item.id) === String(selectedPlan.id)
            ? { ...item, clientsCount: (item.clientsCount ?? 0) + 1 }
            : item,
        ),
      );
      setSelectedPlan((current) =>
        current && String(current.id) === String(selectedPlan.id)
          ? { ...current, clientsCount: (current.clientsCount ?? 0) + 1 }
          : current,
      );
      messageApi.success(
        label('plans.newClientAdded', 'New client created and added to this plan.'),
      );
    } catch (error) {
      messageApi.warning(
        error instanceof Error
          ? label(
              'plans.newClientCreatedNotAssigned',
              'Client was created, but the plan could not be applied: {{error}}',
            ).replace('{{error}}', error.message)
          : label(
              'plans.newClientCreatedNotAssignedShort',
              'Client created; plan was not applied.',
            ),
      );
    }
    return created;
  };

  const removeClientFromPlan = (client: ClientDraft & { id: string }) => {
    if (!selectedPlan) return;
    setLinkedClients((current) => current.filter((item) => item.id !== client.id));
    setPlans((current) =>
      current.map((item) =>
        String(item.id) === String(selectedPlan.id)
          ? { ...item, clientsCount: Math.max(0, (item.clientsCount ?? 0) - 1) }
          : item,
      ),
    );
    setSelectedPlan((current) =>
      current
        ? { ...current, clientsCount: Math.max(0, (current.clientsCount ?? 0) - 1) }
        : current,
    );
    messageApi.success(label('plans.clientRemovedFromPlan', 'Client removed from this plan.'));
  };

  const closeEditor = () => {
    setEditor(null);
    form.resetFields();
  };
  const createPlan = () => {
    form.setFieldsValue(EMPTY_PLAN);
    setEditor('create');
  };
  const editPlan = (plan: PlanModel) => {
    form.setFieldsValue({ ...EMPTY_PLAN, ...plan, applyToExistingClients: false });
    setEditor('edit');
  };
  const savePlan = async () => {
    const values = await form.validateFields();
    const applyToExisting = Boolean(values.applyToExistingClients);
    const planValues = { ...values };
    delete planValues.applyToExistingClients;

    if (editor === 'edit' && selectedPlan) {
      const updatedPlan: PlanModel = {
        ...selectedPlan,
        ...planValues,
        id: selectedPlan.id,
        clientsCount: selectedPlan.clientsCount ?? 0,
      };
      setPlans((current) =>
        current.map((plan) => (plan.id === selectedPlan.id ? updatedPlan : plan)),
      );
      setSelectedPlan(updatedPlan);

      if (applyToExisting) {
        const assigned = linkedClients.filter(
          (client) => String(client.planId) === String(selectedPlan.id),
        );
        let applied = 0;
        const failed: string[] = [];
        for (const client of assigned) {
          try {
            await applyPlanToClient(updatedPlan, client.email, []);
            applied += 1;
          } catch {
            failed.push(client.email);
          }
        }
        if (failed.length) {
          messageApi.warning(
            label(
              'plans.applyPartial',
              'Plan saved. Applied to ' + applied + '; failed for ' + failed.join(', ') + '.',
            ),
          );
        } else {
          messageApi.success(
            label('plans.applied', 'Plan saved and applied to ' + applied + ' client(s).'),
          );
        }
      } else {
        messageApi.success(label('plans.localSave', 'Plan saved.'));
      }
    } else {
      const plan: PlanModel = { ...planValues, id: nextPlanDraftId++, clientsCount: 0 };
      setPlans((current) => [...current, plan]);
      messageApi.success(label('plans.created', 'Plan saved.'));
    }
    closeEditor();
  };
  const deletePlan = () => {
    if (!selectedPlan) return;
    setPlans((current) => current.filter((plan) => plan.id !== selectedPlan.id));
    setLinkedClients((current) =>
      current.filter((client) => String(client.planId) !== String(selectedPlan.id)),
    );
    setSelectedPlan(null);
    setDeleteOpen(false);
  };
  const openAddClient = () => {
    clientForm.setFieldsValue({ email: '', planId: selectedPlan?.id ?? '', inbounds: [] });
    setClientOpen(true);
  };
  const submitClient = async () => {
    if (clientSubmitting) return;
    setClientSubmitting(true);
    try {
      const values = await clientForm.validateFields();
      const plan = plans.find((item) => String(item.id) === String(values.planId));
      if (!plan) {
        messageApi.error(label('plans.selectPlan', 'Choose a plan first.'));
        return;
      }
      const normalizedEmail = values.email.trim().toLocaleLowerCase();
      if (
        linkedClients.some((client) => client.email.trim().toLocaleLowerCase() === normalizedEmail)
      ) {
        messageApi.error(
          label('plans.clientAlreadyAssigned', 'This client is already assigned to a plan.'),
        );
        return;
      }
      await applyPlanToClient(plan, values.email.trim(), values.inbounds ?? [], values);
      const client = { ...values, email: values.email.trim(), id: RandomUtil.randomUUID() };
      setLinkedClients((current) => [...current, client]);
      setPlans((current) =>
        current.map((item) =>
          String(item.id) === String(values.planId)
            ? { ...item, clientsCount: (item.clientsCount ?? 0) + 1 }
            : item,
        ),
      );
      setSelectedPlan((current) =>
        current && String(current.id) === String(values.planId)
          ? { ...current, clientsCount: (current.clientsCount ?? 0) + 1 }
          : current,
      );
      messageApi.success(
        label('plans.applyExistingClient', 'Plan and selected inbounds applied to client.'),
      );
      setClientOpen(false);
      clientForm.resetFields();
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : label('plans.applyFailed', 'Could not apply plan.'),
      );
    } finally {
      setClientSubmitting(false);
    }
  };
  const sheetFooter = (
    onCancel: () => void,
    onSave: () => void,
    saveText: string,
    loading = false,
  ) => (
    <div className="act pn-sheet-footer">
      <Button onClick={onCancel}>{label('common.cancel', 'Cancel')}</Button>
      <Button type="primary" loading={loading} onClick={onSave}>
        {saveText}
      </Button>
    </div>
  );

  if (selectedPlan)
    return (
      <div className="pn-page pn-plan-detail-page">
        {messageContextHolder}
        <header className="hd">
          <div className="t">
            <h1>{selectedPlan.name}</h1>
            <p>{label('plans.detailSubtitle', 'Plan rules and assigned clients')}</p>
          </div>
          <Space wrap>
            <Button onClick={() => setSelectedPlan(null)}>{label('common.back', 'Back')}</Button>
            <Button onClick={() => editPlan(selectedPlan)}>
              {label('common.edit', 'Edit plan')}
            </Button>
            <Button onClick={openAddClient}>
              {label('plans.addExistingClient', 'Add existing')}
            </Button>
            <Button type="primary" onClick={() => setNewClientOpen(true)}>
              {label('plans.createClient', 'New client')}
            </Button>
          </Space>
        </header>
        <div className="wrap">
          <div className="g2 pn-plan-stats">
            <PnStatTile
              label={label('plans.traffic', 'Traffic')}
              value={selectedPlan.totalGB === 0 ? '∞' : selectedPlan.totalGB + ' GB'}
              hint={label('plans.reusableRule', 'Reusable rule')}
            />
            <PnStatTile
              label={label('plans.duration', 'Duration')}
              value={
                selectedPlan.durationDays === 0
                  ? label('plans.noExpiry', 'No expiry')
                  : selectedPlan.durationDays + ' days'
              }
            />
            <PnStatTile
              label={label('plans.clients', 'Clients')}
              value={selectedPlan.clientsCount ?? 0}
            />
          </div>
          <Tabs
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key as 'clients' | 'keys')}
            items={[
              {
                key: 'clients',
                label: label('plans.clients', 'Clients'),
                children: (
                  <div className="pn-empty-state">
                    {linkedClients.filter(
                      (client) => String(client.planId) === String(selectedPlan.id),
                    ).length ? (
                      linkedClients
                        .filter((client) => String(client.planId) === String(selectedPlan.id))
                        .map((client) => (
                          <div
                            key={client.id}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              padding: '10px 14px',
                              marginBottom: 8,
                              borderRadius: 10,
                              background: 'rgba(132, 148, 255, 0.08)',
                            }}
                          >
                            <Typography.Text>{client.email}</Typography.Text>
                            <Space size={8}>
                              {client.telegramId ? (
                                <Typography.Text type="secondary">
                                  {client.telegramId}
                                </Typography.Text>
                              ) : null}
                              <Popconfirm
                                title={label(
                                  'plans.removeClientTitle',
                                  'Remove this client from the plan?',
                                )}
                                description={label(
                                  'plans.removeClientDescription',
                                  'The client account will remain on the VPS.',
                                )}
                                okText={label('common.remove', 'Remove')}
                                cancelText={label('common.cancel', 'Cancel')}
                                onConfirm={() => removeClientFromPlan(client)}
                              >
                                <Button
                                  danger
                                  type="text"
                                  size="small"
                                  icon={<DeleteOutlined aria-hidden />}
                                  aria-label={label(
                                    'plans.removeClient',
                                    'Remove client from plan',
                                  )}
                                />
                              </Popconfirm>
                            </Space>
                          </div>
                        ))
                    ) : (
                      <Empty
                        description={label('plans.noClients', 'No clients use this plan yet')}
                      />
                    )}
                    <Space wrap>
                      <Button onClick={openAddClient}>
                        {label('plans.addExistingClient', 'Add existing')}
                      </Button>
                      <Button type="primary" onClick={() => setNewClientOpen(true)}>
                        {label('plans.createClient', 'New client')}
                      </Button>
                    </Space>
                  </div>
                ),
              },
              {
                key: 'keys',
                label: label('plans.keys', 'Keys'),
                children: (
                  <div className="pn-empty-state">
                    <Empty
                      description={label(
                        'plans.keysPending',
                        'Subscription keys appear after clients are assigned',
                      )}
                    />
                    <Space>
                      <Button disabled>{label('plans.copyAllKeys', 'Copy all keys')}</Button>
                      <Button disabled>{label('common.export', 'Export')}</Button>
                    </Space>
                  </div>
                ),
              },
            ]}
          />
          <div className="pn-plan-rule-summary">
            <b>{label('plans.rules', 'Plan rules')}</b>
            <div className="kv">
              <span>{label('plans.ipLimit', 'IP limit')}</span>
              <span>{selectedPlan.limitIp || '∞'}</span>
            </div>
            <div className="kv">
              <span>{label('plans.hwidLimit', 'HWID limit')}</span>
              <span>{selectedPlan.hwidLimit || '∞'}</span>
            </div>
            <div className="kv">
              <span>{label('plans.trafficReset', 'Traffic reset')}</span>
              <span>{selectedPlan.trafficReset ?? 'never'}</span>
            </div>
            <div className="kv">
              <span>{label('plans.startAfterFirstUse', 'Start after first use')}</span>
              <span>
                {selectedPlan.startAfterFirstUse
                  ? label('common.yes', 'Yes')
                  : label('common.no', 'No')}
              </span>
            </div>
          </div>
          <Button danger onClick={() => setDeleteOpen(true)}>
            {label('plans.delete', 'Delete plan')}
          </Button>
        </div>
        <ClientFormModal
          open={newClientOpen}
          mode="add"
          client={null}
          inbounds={clientInbounds}
          tgBotEnable={tgBotEnable}
          groups={[]}
          save={createNewPlanClient}
          onOpenChange={setNewClientOpen}
        />
        <ResponsiveSheet
          open={editor !== null}
          title={
            editor === 'edit'
              ? label('plans.editTitle', 'Edit plan')
              : label('plans.newTitle', 'New plan')
          }
          onClose={closeEditor}
          footer={sheetFooter(closeEditor, () => void savePlan(), label('common.save', 'Save'))}
        >
          <Form form={form} layout="vertical" initialValues={EMPTY_PLAN}>
            <Form.Item
              name="name"
              label={label('common.name', 'Name')}
              rules={[{ required: true }]}
            >
              <Input maxLength={80} />
            </Form.Item>
            <div className="pn-form-grid">
              <Form.Item
                name="totalGB"
                label={label('plans.trafficGB', 'Traffic (GB)')}
                extra={label('plans.zeroUnlimited', '0 means unlimited')}
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="durationDays"
                label={label('plans.durationDays', 'Duration (days)')}
                extra={label('plans.zeroNoExpiry', '0 means no expiry')}
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="limitIp" label={label('plans.ipLimit', 'IP limit')}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="hwidLimit" label={label('plans.hwidLimit', 'HWID limit')}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </div>
            <Form.Item name="trafficReset" label={label('plans.trafficReset', 'Traffic reset')}>
              <Select
                options={['never', 'hourly', 'daily', 'weekly', 'monthly'].map((value) => ({
                  value,
                  label: label('plans.reset.' + value, value),
                }))}
              />
            </Form.Item>

            {editor === 'edit' && (
              <Form.Item name="startAfterFirstUse" valuePropName="checked">
                <Switch aria-label={label('plans.startAfterFirstUse', 'Start after first use')} />{' '}
                <span>{label('plans.startAfterFirstUse', 'Start after first use')}</span>
              </Form.Item>
            )}
            {editor === 'edit' && (
              <Form.Item name="applyToExistingClients" valuePropName="checked">
                <Switch
                  aria-label={label('plans.applyExisting', 'Apply changes to existing clients')}
                />{' '}
                <span>{label('plans.applyExisting', 'Apply changes to existing clients')}</span>
              </Form.Item>
            )}
          </Form>
        </ResponsiveSheet>
        <ResponsiveSheet
          open={deleteOpen}
          title={label('plans.deleteTitle', 'Delete plan?')}
          onClose={() => setDeleteOpen(false)}
          footer={sheetFooter(
            () => setDeleteOpen(false),
            deletePlan,
            label('plans.delete', 'Delete plan'),
          )}
        >
          <p>
            {label(
              'plans.deleteNotice',
              'Assigned clients keep their current limits and become unassigned.',
            )}
          </p>
        </ResponsiveSheet>
        <ResponsiveSheet
          open={clientOpen}
          title={label('plans.applyExistingClient', 'Apply plan to existing client')}
          onClose={() => setClientOpen(false)}
          footer={sheetFooter(
            () => setClientOpen(false),
            () => void submitClient(),
            label('plans.applyPlanAction', 'Apply plan'),
            clientSubmitting,
          )}
        >
          <Form form={clientForm} layout="vertical">
            <Form.Item
              name="email"
              label={label('client.email', 'Email')}
              rules={[{ required: true }]}
              extra={label(
                'plans.existingClientHint',
                'Enter an existing client email. Create new clients from the Clients page.',
              )}
            >
              <Input placeholder="client@example.com" />
            </Form.Item>
            <Form.Item name="planId" label={label('plans.plan', 'Plan')}>
              <Select options={plans.map((plan) => ({ value: plan.id, label: plan.name }))} />
            </Form.Item>
            <Form.Item name="telegramId" label={label('client.telegramId', 'Telegram user ID')}>
              <Input />
            </Form.Item>
            <Form.Item name="group" label={label('menu.groups', 'Group')}>
              <Input />
            </Form.Item>
            <Form.Item
              name="inbounds"
              label={label('menu.inbounds', 'Inbounds')}
              extra={label(
                'plans.inboundAttachHint',
                'Selected inbounds will be attached to this existing client.',
              )}
              rules={[
                {
                  required: true,
                  type: 'array',
                  min: 1,
                  message: label('plans.selectInbound', 'Choose at least one inbound.'),
                },
              ]}
            >
              <Select
                mode="multiple"
                tagRender={selectTagRender}
                showSearch
                optionFilterProp="label"
                loading={inboundsLoading}
                disabled={inboundsLoading || inbounds.length === 0}
                aria-label={label('menu.inbounds', 'Inbounds')}
                placeholder={
                  inboundsLoading
                    ? label('common.loading', 'Loading inbounds…')
                    : inbounds.length
                      ? label('plans.chooseInbounds', 'Choose one or more inbounds')
                      : label('plans.noActiveInbounds', 'No inbounds are available')
                }
                options={inbounds
                  .filter((inbound) => inbound.enable !== false)
                  .map((inbound) => ({
                    value: inbound.id,
                    label:
                      [inbound.remark, inbound.tag, inbound.protocol].filter(Boolean).join(' · ') ||
                      `Inbound #${inbound.id}`,
                  }))}
              />
            </Form.Item>
            <Typography.Text type="secondary">
              {label(
                'plans.rulesFromPlan',
                'Traffic, expiry, IP and HWID limits come from the selected plan.',
              )}
            </Typography.Text>
          </Form>
        </ResponsiveSheet>
      </div>
    );

  return (
    <div className="pn-page">
      {messageContextHolder}
      <header className="hd">
        <div className="t">
          <h1>{label('menu.plans', 'Plans')}</h1>
          <p>{label('plans.subtitle', 'Reusable rules for client accounts')}</p>
        </div>
        <Button type="primary" onClick={createPlan}>
          {label('plans.newTitle', 'New plan')}
        </Button>
      </header>
      <div className="wrap">
        <div className="g2 pn-plan-stats">
          <PnStatTile label={label('plans.plans', 'Plans')} value={plans.length} />
          <PnStatTile label={label('plans.online', 'Online')} value={0} color="var(--cy)" />
          <PnStatTile label={label('plans.clients', 'Clients')} value={clients} color="var(--gr)" />
        </div>
        {plans.length ? (
          <div className="g2 pn-plan-grid">
            {plans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                onClick={() => {
                  setSelectedPlan(plan);
                  setActiveTab('clients');
                }}
                onEdit={() => {
                  setSelectedPlan(plan);
                  editPlan(plan);
                }}
              />
            ))}
            <button className="card pn-new-plan" onClick={createPlan}>
              ＋<span>{label('plans.newTitle', 'New plan')}</span>
            </button>
          </div>
        ) : (
          <div className="pn-empty-state">
            <Empty
              description={label(
                'plans.empty',
                'Create a plan to reuse traffic, expiry and device limits',
              )}
            />
            <Button type="primary" onClick={createPlan}>
              {label('plans.newTitle', 'New plan')}
            </Button>
          </div>
        )}
      </div>
      <ResponsiveSheet
        open={editor !== null}
        title={
          editor === 'edit'
            ? label('plans.editTitle', 'Edit plan')
            : label('plans.newTitle', 'New plan')
        }
        onClose={closeEditor}
        footer={sheetFooter(closeEditor, () => void savePlan(), label('common.save', 'Save'))}
      >
        <Form form={form} layout="vertical" initialValues={EMPTY_PLAN}>
          <Form.Item name="name" label={label('common.name', 'Name')} rules={[{ required: true }]}>
            <Input maxLength={80} />
          </Form.Item>
          <div className="pn-form-grid">
            <Form.Item
              name="totalGB"
              label={label('plans.trafficGB', 'Traffic (GB)')}
              extra={label('plans.zeroUnlimited', '0 means unlimited')}
            >
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="durationDays"
              label={label('plans.durationDays', 'Duration (days)')}
              extra={label('plans.zeroNoExpiry', '0 means no expiry')}
            >
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="limitIp" label={label('plans.ipLimit', 'IP limit')}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="hwidLimit" label={label('plans.hwidLimit', 'HWID limit')}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <Form.Item name="trafficReset" label={label('plans.trafficReset', 'Traffic reset')}>
            <Select
              options={['never', 'hourly', 'daily', 'weekly', 'monthly'].map((value) => ({
                value,
                label: label('plans.reset.' + value, value),
              }))}
            />
          </Form.Item>
          <Form.Item name="startAfterFirstUse" valuePropName="checked">
            <Switch aria-label={label('plans.startAfterFirstUse', 'Start after first use')} />{' '}
            <span>{label('plans.startAfterFirstUse', 'Start after first use')}</span>
          </Form.Item>
        </Form>
      </ResponsiveSheet>
    </div>
  );
}

export default function PlansPage() {
  return (
    <Layout className="index-page">
      <AppSidebar />
      <Layout className="content-shell">
        <Layout.Content className="content-area">
          <PlansPageContent />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
