import { useEffect, useMemo, useRef, useState } from 'react';
import { Layout } from 'antd';
import AppSidebar from '@/layouts/AppSidebar';
import {
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tabs,
  Typography,
  message,
  Popconfirm,
} from 'antd';
import { useTranslation } from 'react-i18next';
import { DeleteOutlined, EditOutlined, PlusOutlined, RetweetOutlined } from '@ant-design/icons';
import { PlanCard, PnStatTile, ResponsiveSheet, type PlanModel } from '@/components/pn';
import { clientManagementPath } from '@/api/client-management';
import { ClientHydrateSchema } from '@/schemas/client';
import { SlimInboundListSchema } from '@/schemas/inbound';
import { HttpUtil, RandomUtil } from '@/utils';
import { parseMsg } from '@/utils/zodValidate';
import { selectTagRender } from '@/components/form';
import ClientFormModal from '@/pages/clients/ClientFormModal';
import {
  useClients,
  type ClientRecord,
  type ExternalLink,
  type ExternalLinkInput,
} from '@/hooks/useClients';

type PlanDraft = Omit<PlanModel, 'id' | 'clientsCount'>;
type ClientDraft = {
  email: string;
  planId: number | string;
  telegramId?: string;
  group?: string;
  inbounds?: number[];
};
type PlanKeyResult = { links: string[]; error?: string };
type PlanClientSavePayload =
  | Record<string, unknown>
  | { client: Record<string, unknown>; inboundIds: number[] };
type PlanClientSaveMeta =
  | { isEdit: false; email: string; externalLinks: unknown[] }
  | {
      isEdit: true;
      email: string;
      attach: number[];
      detach: number[];
      externalLinks: ExternalLinkInput[];
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
  inboundIds: [],
  trafficReset: 'never',
  startAfterFirstUse: false,
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

const getExistingClientAssignment = async (
  email: string,
): Promise<Pick<ClientDraft, 'telegramId' | 'group' | 'inbounds'>> => {
  const raw = await HttpUtil.get(clientManagementPath('get', email));
  const hydrated = parseMsg(raw, ClientHydrateSchema, 'clients/get');
  if (!hydrated?.success || !hydrated.obj?.client) {
    throw new Error(
      hydrated?.msg || `Client ${email} not found. Create it on the Clients page first.`,
    );
  }

  // Store only plan-link metadata, using the client's current settings as read-only context.
  const client = hydrated.obj.client;
  return {
    telegramId: String(client.tgId ?? ''),
    group: String(client.group ?? ''),
    inbounds: Array.isArray(hydrated.obj.inboundIds) ? hydrated.obj.inboundIds : [],
  };
};

function PlansPageContent() {
  const { t } = useTranslation();
  const label = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const {
    inbounds: clientInbounds,
    tgBotEnable,
    create: createClient,
    hydrate,
    update,
    attach,
    detach,
    setExternalLinks,
    resetTraffic,
    bulkAdjust,
  } = useClients();
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
  const [editingPlanClient, setEditingPlanClient] = useState<{
    client: ClientRecord;
    inboundIds: number[];
    externalLinks: ExternalLink[];
    tunnelAllowedIPs: Record<number, string>;
  } | null>(null);
  const [editingPlanClientOpen, setEditingPlanClientOpen] = useState(false);
  const [planClientActionEmail, setPlanClientActionEmail] = useState<string | null>(null);
  const [selectedPlanClientIds, setSelectedPlanClientIds] = useState<string[]>([]);
  const [clientSubmitting, setClientSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<'clients' | 'keys'>('clients');
  const [planKeys, setPlanKeys] = useState<Record<string, PlanKeyResult>>({});
  const [focusedKeyEmail, setFocusedKeyEmail] = useState<string | null>(null);
  const keyCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const [form] = Form.useForm<PlanDraft>();
  const [clientForm] = Form.useForm<ClientDraft>();
  useEffect(() => {
    if (!selectedPlan || activeTab !== 'keys') return;
    const assigned = linkedClients.filter(
      (client) => String(client.planId) === String(selectedPlan.id),
    );
    const pending = assigned.filter((client) => !(client.email in planKeys));
    if (!pending.length) return;

    let active = true;
    void Promise.all(
      pending.map(async (client) => {
        try {
          const response = await HttpUtil.get(
            `/panel/api/clients/links/${encodeURIComponent(client.email)}`,
            undefined,
            { silent: true },
          );
          if (!response?.success) {
            throw new Error(response?.msg || 'Could not load client keys.');
          }
          const links = Array.isArray(response.obj)
            ? response.obj.filter((link): link is string => typeof link === 'string')
            : [];
          return [client.email, { links }] as const;
        } catch (error) {
          return [
            client.email,
            {
              links: [],
              error: error instanceof Error ? error.message : 'Could not load client keys.',
            },
          ] as const;
        }
      }),
    ).then((results) => {
      if (active) setPlanKeys((current) => ({ ...current, ...Object.fromEntries(results) }));
    });
    return () => {
      active = false;
    };
  }, [activeTab, linkedClients, planKeys, selectedPlan]);

  useEffect(() => {
    if (activeTab !== 'keys' || !focusedKeyEmail) return;
    const frame = window.requestAnimationFrame(() => {
      keyCardRefs.current[focusedKeyEmail]?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, focusedKeyEmail, planKeys]);

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
    const sourceClient: Record<string, unknown> =
      'client' in payload && payload.client && typeof payload.client === 'object'
        ? (payload.client as Record<string, unknown>)
        : payload;
    const requestedInboundIds =
      'inboundIds' in payload && Array.isArray(payload.inboundIds)
        ? payload.inboundIds.filter(
            (id): id is number => typeof id === 'number' && Number.isInteger(id),
          )
        : [];
    const inboundIds = selectedPlan.inboundIds?.length
      ? selectedPlan.inboundIds
      : requestedInboundIds;
    const durationDays = Math.max(0, Number(selectedPlan.durationDays) || 0);
    const clientPayload: Record<string, unknown> = {
      ...sourceClient,
      totalGB: Math.round(Math.max(0, Number(selectedPlan.totalGB) || 0) * 1024 ** 3),
      expiryTime:
        durationDays > 0
          ? selectedPlan.startAfterFirstUse
            ? -durationDays * 24 * 60 * 60 * 1000
            : Date.now() + durationDays * 24 * 60 * 60 * 1000
          : 0,
      limitIp: Math.max(0, Number(selectedPlan.limitIp) || 0),
      limitHwid: Math.max(0, Number(selectedPlan.hwidLimit) || 0),
      trafficReset: selectedPlan.trafficReset || 'never',
    };
    const created = await createClient({ client: clientPayload, inboundIds });
    if (!created?.success) return created;
    const clientRecord = clientPayload;
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
    messageApi.success(label('plans.newClientAdded', 'New client created and added to this plan.'));
    return created;
  };

  const removeClientFromPlan = (client: ClientDraft & { id: string }) => {
    if (!selectedPlan) return;
    setLinkedClients((current) => current.filter((item) => item.id !== client.id));
    setSelectedPlanClientIds((current) => current.filter((id) => id !== client.id));
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

  const openPlanClientEdit = async (client: ClientDraft & { id: string }) => {
    try {
      const full = await hydrate(client.email);
      if (!full?.client) throw new Error('Could not load this client for editing.');
      setEditingPlanClient({
        client: full.client,
        inboundIds: full.inboundIds ?? client.inbounds ?? [],
        externalLinks: full.externalLinks ?? [],
        tunnelAllowedIPs: full.tunnelAllowedIPs ?? {},
      });
      setEditingPlanClientOpen(true);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : 'Could not load this client.');
    }
  };

  const savePlanClient = async (
    payload: PlanClientSavePayload,
    meta: PlanClientSaveMeta,
  ): Promise<{ success?: boolean; msg?: string } | null> => {
    if (!meta.isEdit) return null;
    const updated = await update(meta.email, payload);
    if (!updated?.success) return updated;
    const rawEmail = (payload as { email?: unknown }).email;
    const email = typeof rawEmail === 'string' && rawEmail.trim() ? rawEmail.trim() : meta.email;
    if (meta.attach.length) {
      const result = await attach(email, meta.attach);
      if (!result?.success) return result;
    }
    if (meta.detach.length) {
      const result = await detach(email, meta.detach);
      if (!result?.success) return result;
    }
    const links = await setExternalLinks(email, meta.externalLinks);
    if (!links?.success) return links;
    setLinkedClients((current) =>
      current.map((item) => (item.email === meta.email ? { ...item, email } : item)),
    );
    return updated;
  };

  const addClientDays = async (client: ClientDraft & { id: string }) => {
    setPlanClientActionEmail(client.email);
    try {
      const full = await hydrate(client.email);
      const record = full?.client;
      if (!record) throw new Error('Could not load this client.');
      if (!Number(record.expiryTime)) {
        throw new Error('This client has no expiry date to extend.');
      }
      const result = await bulkAdjust([client.email], 30, 0);
      if (!result?.success) throw new Error(result?.msg || 'Could not add 30 days.');
      messageApi.success('30 days added to ' + client.email + '.');
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : 'Could not add 30 days.');
    } finally {
      setPlanClientActionEmail(null);
    }
  };

  const resetClientTraffic = async (client: ClientDraft & { id: string }) => {
    setPlanClientActionEmail(client.email);
    try {
      const full = await hydrate(client.email);
      if (!full?.client) throw new Error('Could not load this client.');
      const result = await resetTraffic(full.client);
      if (!result?.success) throw new Error(result?.msg || 'Could not reset client traffic.');
      messageApi.success('Traffic usage reset for ' + client.email + '.');
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : 'Could not reset traffic.');
    } finally {
      setPlanClientActionEmail(null);
    }
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
    form.setFieldsValue({ ...EMPTY_PLAN, ...plan });
    setEditor('edit');
  };
  const savePlan = async () => {
    const values = await form.validateFields();
    const planValues = { ...values };

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

      messageApi.success(label('plans.localSave', 'Plan saved.'));
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
    clientForm.setFieldsValue({
      email: '',
      planId: selectedPlan?.id ?? '',
      inbounds: selectedPlan?.inboundIds ?? [],
    });
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
      const email = values.email.trim();
      const existingSettings = await getExistingClientAssignment(email);
      const client = {
        ...existingSettings,
        email,
        planId: values.planId,
        id: RandomUtil.randomUUID(),
      };
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
        label(
          'plans.applyExistingClient',
          'Client assigned to plan. Existing settings were preserved.',
        ),
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

  const assignedPlanClients = selectedPlan
    ? linkedClients.filter((client) => String(client.planId) === String(selectedPlan.id))
    : [];
  const allPlanClientsSelected =
    assignedPlanClients.length > 0 &&
    assignedPlanClients.every((client) => selectedPlanClientIds.includes(client.id));
  const removeSelectedPlanClients = () => {
    const selected = new Set(selectedPlanClientIds);
    assignedPlanClients
      .filter((client) => selected.has(client.id))
      .forEach((client) => removeClientFromPlan(client));
    setSelectedPlanClientIds([]);
  };

  if (selectedPlan)
    return (
      <div className="pn-page pn-plan-detail-page">
        {messageContextHolder}
        <header className="hd">
          <div className="t">
            <h1>{selectedPlan.name}</h1>
            <p>{label('plans.detailSubtitle', 'Plan rules and assigned clients')}</p>
          </div>
          <Button
            className="pn-plan-back-button"
            onClick={() => {
              setSelectedPlan(null);
              setSelectedPlanClientIds([]);
            }}
          >
            {label('common.back', 'Back')}
          </Button>
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
                  <div className="pn-empty-state pn-plan-clients-panel">
                    <div className="pn-plan-client-toolbar">
                      <Space wrap size={[8, 8]}>
                        <Checkbox
                          checked={allPlanClientsSelected}
                          disabled={!assignedPlanClients.length}
                          onChange={(event) =>
                            setSelectedPlanClientIds(
                              event.target.checked
                                ? assignedPlanClients.map((client) => client.id)
                                : [],
                            )
                          }
                        >
                          {label('common.selectAll', 'Select all')}
                        </Checkbox>
                        {selectedPlanClientIds.length > 0 && (
                          <Popconfirm
                            title={label(
                              'plans.removeSelectedTitle',
                              'Remove selected clients from this plan?',
                            )}
                            okText={label('common.remove', 'Remove')}
                            cancelText={label('common.cancel', 'Cancel')}
                            onConfirm={removeSelectedPlanClients}
                          >
                            <Button danger size="small">
                              {label('plans.removeSelected', 'Remove selected')} (
                              {selectedPlanClientIds.length})
                            </Button>
                          </Popconfirm>
                        )}
                      </Space>
                      <Space wrap size={[8, 8]}>
                        <Button onClick={openAddClient}>
                          {label('plans.addExistingClient', 'Add existing')}
                        </Button>
                        <Button type="primary" onClick={() => setNewClientOpen(true)}>
                          {label('plans.createClient', 'New client')}
                        </Button>
                      </Space>
                    </div>
                    {assignedPlanClients.length ? (
                      <div className="pn-plan-client-grid">
                        {assignedPlanClients.map((client) => {
                          const clientInboundIds = client.inbounds?.length
                            ? client.inbounds
                            : (selectedPlan.inboundIds ?? []);
                          const busy = planClientActionEmail === client.email;
                          return (
                            <article className="pn-plan-client-row" key={client.id}>
                              <div className="pn-plan-client-heading">
                                <Checkbox
                                  checked={selectedPlanClientIds.includes(client.id)}
                                  onChange={(event) =>
                                    setSelectedPlanClientIds((current) =>
                                      event.target.checked
                                        ? [...new Set([...current, client.id])]
                                        : current.filter((id) => id !== client.id),
                                    )
                                  }
                                  aria-label={`Select ${client.email}`}
                                />
                                <Button
                                  type="link"
                                  className="pn-plan-client-name"
                                  title={client.email}
                                  onClick={() => {
                                    setFocusedKeyEmail(client.email);
                                    setActiveTab('keys');
                                  }}
                                >
                                  {client.email}
                                </Button>
                                {client.telegramId ? (
                                  <Typography.Text type="secondary">
                                    {client.telegramId}
                                  </Typography.Text>
                                ) : null}
                              </div>
                              <div className="pn-plan-client-inbounds" aria-label="Inbounds">
                                {clientInboundIds.length ? (
                                  clientInboundIds.map((id) => {
                                    const inbound = inbounds.find((item) => item.id === id);
                                    const name =
                                      inbound?.remark ||
                                      inbound?.tag ||
                                      inbound?.protocol ||
                                      String(id);
                                    return (
                                      <Tag key={id} title={name}>
                                        {name}
                                      </Tag>
                                    );
                                  })
                                ) : (
                                  <Typography.Text type="secondary">
                                    {label('pages.clients.attachedInbounds', 'Inbounds')}: —
                                  </Typography.Text>
                                )}
                              </div>
                              <Space wrap size={[4, 4]} className="pn-plan-client-actions">
                                <Button
                                  size="small"
                                  icon={<EditOutlined aria-hidden />}
                                  aria-label={label('common.edit', 'Edit')}
                                  title={label('common.edit', 'Edit')}
                                  onClick={() => void openPlanClientEdit(client)}
                                />
                                <Popconfirm
                                  title={label('pages.inbounds.resetTraffic', 'Reset traffic')}
                                  description={label(
                                    'pages.inbounds.resetTrafficContent',
                                    'Reset this client’s traffic usage?',
                                  )}
                                  okText={label('reset', 'Reset')}
                                  cancelText={label('cancel', 'Cancel')}
                                  onConfirm={() => void resetClientTraffic(client)}
                                >
                                  <Button
                                    size="small"
                                    icon={<RetweetOutlined aria-hidden />}
                                    aria-label={label('plans.resetTraffic', 'Reset GB')}
                                    title={label('plans.resetTraffic', 'Reset GB')}
                                    loading={busy}
                                  />
                                </Popconfirm>
                                <Popconfirm
                                  title={label('plans.add30DaysTitle', 'Add 30 days?')}
                                  description={label(
                                    'plans.add30DaysDescription',
                                    'Extend this client’s expiry date by 30 days.',
                                  )}
                                  okText={label('common.add', 'Add')}
                                  cancelText={label('common.cancel', 'Cancel')}
                                  onConfirm={() => void addClientDays(client)}
                                >
                                  <Button
                                    size="small"
                                    icon={<PlusOutlined aria-hidden />}
                                    loading={busy}
                                  >
                                    {label('plans.add30Days', '+30 days')}
                                  </Button>
                                </Popconfirm>
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
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <Empty
                        description={label('plans.noClients', 'No clients use this plan yet')}
                      />
                    )}
                  </div>
                ),
              },
              {
                key: 'keys',
                label: label('plans.keys', 'Keys'),
                children: (
                  <div className="pn-plan-keys">
                    {linkedClients
                      .filter((client) => String(client.planId) === String(selectedPlan.id))
                      .sort((left, right) =>
                        left.email === focusedKeyEmail
                          ? -1
                          : right.email === focusedKeyEmail
                            ? 1
                            : 0,
                      )
                      .map((client) => {
                        const result = planKeys[client.email];
                        const clientInboundIds =
                          Array.isArray(client.inbounds) && client.inbounds.length
                            ? client.inbounds
                            : (selectedPlan.inboundIds ?? []);
                        return (
                          <section
                            className={
                              client.email === focusedKeyEmail
                                ? 'pn-plan-key-card is-focused'
                                : 'pn-plan-key-card'
                            }
                            key={client.id}
                            ref={(node) => {
                              keyCardRefs.current[client.email] = node;
                            }}
                          >
                            <b>{client.email}</b>
                            {!result ? (
                              <Spin size="small" />
                            ) : result.links.length ? (
                              <div className="pn-plan-key-list">
                                {result.links.map((link, index) => {
                                  const scheme = link.split(':', 1)[0].toLowerCase();
                                  const protocol =
                                    scheme === 'ss'
                                      ? 'shadowsocks'
                                      : scheme === 'hy2'
                                        ? 'hysteria'
                                        : scheme;
                                  const matches = inbounds.filter(
                                    (inbound) =>
                                      clientInboundIds.includes(inbound.id) &&
                                      inbound.protocol.toLowerCase() === protocol,
                                  );
                                  const inboundName =
                                    matches.length === 1
                                      ? matches[0].remark || matches[0].tag || matches[0].protocol
                                      : matches.length > 1
                                        ? matches
                                            .map(
                                              (inbound) =>
                                                inbound.remark || inbound.tag || inbound.protocol,
                                            )
                                            .join(', ')
                                        : label('menu.inbounds', 'Inbound');
                                  return (
                                    <div
                                      className="pn-plan-key-item"
                                      key={client.email + ':' + index}
                                    >
                                      <div className="pn-plan-key-meta">
                                        <b>{inboundName}</b>
                                        <span>
                                          {(matches[0]?.protocol || scheme).toUpperCase()}
                                        </span>
                                      </div>
                                      <Typography.Text
                                        className="pn-plan-key-copy"
                                        copyable={{ text: link }}
                                      >
                                        {label('plans.copyKey', 'Copy key')}
                                      </Typography.Text>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <Typography.Text type="secondary">
                                {result.error ||
                                  label('plans.noClientKeys', 'No keys available for this client.')}
                              </Typography.Text>
                            )}
                          </section>
                        );
                      })}
                    {!linkedClients.some(
                      (client) => String(client.planId) === String(selectedPlan.id),
                    ) && (
                      <Empty
                        description={label(
                          'plans.keysPending',
                          'Subscription keys appear after clients are assigned',
                        )}
                      />
                    )}
                  </div>
                ),
              },
            ]}
          />
          <div className="pn-plan-rule-summary">
            <b>{label('plans.rules', 'Plan rules')}</b>
            <div className="kv">
              <span>{label('plans.traffic', 'Traffic')}</span>
              <span>
                {selectedPlan.totalGB > 0
                  ? selectedPlan.totalGB + ' GB'
                  : label('plans.unlimited', 'Unlimited')}
              </span>
            </div>
            <div className="kv">
              <span>{label('plans.duration', 'Duration')}</span>
              <span>
                {selectedPlan.durationDays > 0
                  ? selectedPlan.durationDays + ' days'
                  : label('plans.noExpiry', 'No expiry')}
              </span>
            </div>
            <div className="kv">
              <span>{label('pages.clients.attachedInbounds', 'Inbounds')}</span>
              <span>
                {selectedPlan.inboundIds?.length
                  ? selectedPlan.inboundIds
                      .map((id) => {
                        const inbound = inbounds.find((item) => item.id === id);
                        return inbound?.remark || inbound?.tag || inbound?.protocol || String(id);
                      })
                      .join(', ')
                  : label('plans.selectPerClient', 'Selected for each client')}
              </span>
            </div>
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
          planPreset={selectedPlan ?? undefined}
          onOpenChange={setNewClientOpen}
        />
        <ClientFormModal
          open={editingPlanClientOpen}
          mode="edit"
          client={editingPlanClient?.client ?? null}
          inbounds={clientInbounds}
          attachedIds={editingPlanClient?.inboundIds ?? []}
          attachedExternalLinks={editingPlanClient?.externalLinks ?? []}
          tunnelAllowedIPs={editingPlanClient?.tunnelAllowedIPs ?? {}}
          tgBotEnable={tgBotEnable}
          groups={[]}
          save={savePlanClient}
          resetTraffic={resetTraffic}
          onOpenChange={setEditingPlanClientOpen}
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
            <Form.Item
              name="inboundIds"
              label={label('pages.clients.attachedInbounds', 'Inbounds')}
            >
              <Select
                mode="multiple"
                allowClear
                tagRender={selectTagRender}
                options={inbounds
                  .filter((inbound) => inbound.enable !== false)
                  .map((inbound) => ({
                    value: inbound.id,
                    label:
                      String(inbound.remark || inbound.tag || inbound.protocol) +
                      ' · ' +
                      inbound.protocol,
                  }))}
              />
            </Form.Item>

            <Form.Item name="startAfterFirstUse" valuePropName="checked">
              <Switch aria-label={label('plans.startAfterFirstUse', 'Start after first use')} />{' '}
              <span>{label('plans.startAfterFirstUse', 'Start after first use')}</span>
            </Form.Item>
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
            <Typography.Text type="secondary">
              {label(
                'plans.rulesFromPlan',
                'This only links the client to the plan. Current expiry, limits, inbounds and keys stay unchanged.',
              )}
            </Typography.Text>
          </Form>
        </ResponsiveSheet>
      </div>
    );

  return (
    <div className="pn-page">
      {messageContextHolder}
      <header className="hd pn-plans-header">
        <div className="t">
          <h1>{label('menu.plans', 'Plans')}</h1>
          <p>{label('plans.subtitle', 'Reusable rules for client accounts')}</p>
        </div>
        <Button type="primary" onClick={createPlan}>
          {label('plans.newTitle', 'New plan')}
        </Button>
        <div className="g2 pn-plan-stats">
          <PnStatTile label={label('plans.plans', 'Plans')} value={plans.length} />
          <PnStatTile label={label('plans.online', 'Online')} value={0} color="var(--cy)" />
          <PnStatTile label={label('plans.clients', 'Clients')} value={clients} color="var(--gr)" />
        </div>
      </header>
      <div className="wrap">
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
          <Form.Item name="inboundIds" label={label('pages.clients.attachedInbounds', 'Inbounds')}>
            <Select
              mode="multiple"
              allowClear
              tagRender={selectTagRender}
              options={inbounds
                .filter((inbound) => inbound.enable !== false)
                .map((inbound) => ({
                  value: inbound.id,
                  label:
                    String(inbound.remark || inbound.tag || inbound.protocol) +
                    ' · ' +
                    inbound.protocol,
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
