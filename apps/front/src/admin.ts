import '@fontsource/eb-garamond/500.css';
import '@fontsource-variable/inter';
import './admin.css';
import { CATEGORY_LABELS, type Category } from '@way/shared';
import { CATEGORY_COLORS } from './icons.ts';
import { configureSounds, loadCustomSounds, playSound, type SoundKind } from './sounds.ts';

// Settings page: login, level-2 providers (keys, models, on/off, test),
// live status (brief §8.4) and the account password.

interface ProviderStatus {
  id: string;
  type: 'search' | 'llm';
  model: string | null;
  defaultModel: string | null;
  keyEnv: string | null;
  urlEnv: string | null;
  modelEnv: string | null;
  configured: boolean;
  disabled: boolean;
  available: boolean;
  minute: { used: number; limit: number };
  day: { used: number; limit: number };
  breakerOpenUntil: number | null;
  calls: number;
  failures: number;
  avgLatencyMs: number | null;
  lastError: string | null;
}

interface Variable { source: 'settings' | 'env' | null; value: string | null; secret: boolean }

interface SettingsResponse {
  level2: { enabled: boolean; source: 'settings' | 'env' };
  variables: Record<string, Variable>;
  providers: ProviderStatus[];
  routes: Record<Task, { order: string[]; defaults: string[]; custom: boolean }>;
  ui: UiPrefs;
  cache: CachePrefs;
}

type Task = 'write' | 'extract';
const TASKS: [Task, string, string][] = [
  ['write', 'Écriture', 'Scénarios, étapes des chemins, vies des personnages, détours : le texte que vous lisez. Mettez ici la meilleure IA.'],
  ['extract', 'Lecture', 'Rôle des lieux et des personnes d’une histoire, faits extraits du web, traductions : des tâches courtes, nombreuses.'],
];

interface CachePrefs { maxGb: number; refreshDays: number; images: boolean }

interface UiPrefs { sounds: boolean; volume: number; hoverOpen: boolean; meanwhileMaxSpan: number }

interface AdminResponse {
  mode: { store: string; queue: string };
  queue: { waiting: number; active: number; level2?: { waiting: number; active: number } };
  keys: Record<'pending' | 'done' | 'partial' | 'failed', number>;
  pois: number;
  realms: { realms: number; named: number; emblems: number; faiths: number; watched?: number };
  cache: { bytes: number; maxBytes: number; media: { bytes: number; count: number } };
  level2: { enabled: boolean; mode: 'active' | 'degraded' | 'no-llm' | 'off'; providers: ProviderStatus[] };
}

/** How each service is presented; grouped by the variable that configures it. */
interface Service { name: string; note: string; link?: string; field: string; placeholder?: string }
const SERVICES: Record<string, Service> = {
  GEMINI_API_KEY: {
    name: 'Google Gemini', note: 'Gratuit, sans carte : jusqu’à 1 000 requêtes par jour.',
    link: 'https://aistudio.google.com/apikey', field: 'Clé API',
  },
  GROQ_API_KEY: {
    name: 'Groq', note: 'Gratuit, sans carte : environ 1 000 requêtes par jour.',
    link: 'https://console.groq.com/keys', field: 'Clé API',
  },
  MISTRAL_API_KEY: {
    name: 'Mistral', note: 'Offre gratuite « Experiment ».', link: 'https://console.mistral.ai/api-keys', field: 'Clé API',
  },
  GITHUB_MODELS_TOKEN: {
    name: 'GitHub Models', note: 'Jeton GitHub avec la permission « Models ».',
    link: 'https://github.com/settings/personal-access-tokens', field: 'Jeton',
  },
  OPENROUTER_API_KEY: {
    name: 'OpenRouter', note: 'Modèles gratuits (suffixe « :free »), quotas bas.',
    link: 'https://openrouter.ai/settings/keys', field: 'Clé API',
  },
  CEREBRAS_API_KEY: {
    name: 'Cerebras', note: 'Gratuit, sans carte : environ 1 000 requêtes par jour, très rapide.',
    link: 'https://cloud.cerebras.ai', field: 'Clé API',
  },
  ANTHROPIC_API_KEY: {
    name: 'Anthropic (Claude)', note: 'Payant : utilisé en dernier recours, plafonné à 200 requêtes par jour.',
    link: 'https://console.anthropic.com/settings/keys', field: 'Clé API',
  },
  OPENAI_API_KEY: {
    name: 'OpenAI', note: 'Payant : utilisé en dernier recours, plafonné à 300 requêtes par jour.',
    link: 'https://platform.openai.com/api-keys', field: 'Clé API',
  },
  DEEPSEEK_API_KEY: {
    name: 'DeepSeek', note: 'Payant (très bon marché) : utilisé en dernier recours.',
    link: 'https://platform.deepseek.com/api_keys', field: 'Clé API',
  },
  OLLAMA_URL: {
    name: 'Ollama (local)', note: 'Un modèle sur votre propre machine : lent sans carte graphique, mais illimité.',
    field: 'Adresse', placeholder: 'http://192.168.1.10:11434',
  },
  TAVILY_API_KEY: {
    name: 'Tavily', note: 'Gratuit : 1 000 recherches par mois.', link: 'https://app.tavily.com', field: 'Clé API',
  },
  BRAVE_API_KEY: {
    name: 'Brave Search', note: 'Payant : carte bancaire requise, le dépassement est facturé.',
    link: 'https://api-dashboard.search.brave.com', field: 'Clé API',
  },
  SEARXNG_URL: {
    name: 'SearXNG', note: 'Votre instance, avec le format JSON activé.', field: 'Adresse', placeholder: 'http://192.168.1.10:8888',
  },
  '': { name: 'Wikipédia', note: 'Toujours disponible, sans clé.', field: '' },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const nf = new Intl.NumberFormat('fr-FR');
const mb = (b: number) => `${nf.format(Math.round(b / 1048576))} Mo`;
const gbf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const size = (b: number) => (b >= 1024 ** 3 ? `${gbf.format(b / 1024 ** 3)} Go` : mb(b));

class Unauthorized extends Error {}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (r.status === 401 && !path.startsWith('/api/auth/login')) {
    showLogin();
    throw new Unauthorized();
  }
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `erreur ${r.status}`);
  return data;
}

// ---------- login ----------

function showLogin(): void {
  $('app').hidden = true;
  $('logout').hidden = true;
  $('who').textContent = '';
  $('login').hidden = false;
  stopStatus();
  $<HTMLInputElement>('login').querySelector<HTMLInputElement>('[name=password]')!.focus();
}

function showApp(me: { user: string; defaultPassword: boolean }): void {
  $('login').hidden = true;
  $('app').hidden = false;
  $('logout').hidden = false;
  $('who').textContent = `connecté : ${me.user}`;
  $('default-password').hidden = !me.defaultPassword;
  void loadSettings();
  selectTab((location.hash.slice(1) as Tab) || 'ai');
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
  const btn = form.querySelector('button')!;
  btn.disabled = true;
  $('login-error').textContent = '';
  try {
    const me = await api<{ user: string; defaultPassword: boolean }>('/api/auth/login', { method: 'POST', body: data });
    form.reset();
    showApp(me);
  } catch (err) {
    $('login-error').textContent = (err as Error).message;
  } finally {
    btn.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  showLogin();
});

// ---------- tabs ----------

type Tab = 'ai' | 'ui' | 'cache' | 'status' | 'account';

function selectTab(tab: Tab): void {
  if (!['ai', 'ui', 'cache', 'status', 'account'].includes(tab)) tab = 'ai';
  document.querySelectorAll<HTMLElement>('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll<HTMLElement>('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  history.replaceState(null, '', `#${tab}`);
  if (tab === 'status' || tab === 'cache') startStatus();
  else stopStatus();
}

document.querySelectorAll<HTMLElement>('[role=tab]').forEach((b) =>
  b.addEventListener('click', () => selectTab(b.dataset.tab as Tab)),
);

// ---------- AI settings ----------

let current: SettingsResponse | null = null;
/** Unsaved edits: variables (null = remove the saved value), switches, orders of the AIs (null = back to the default). */
const draft: {
  env: Record<string, string | null>; disabled: Set<string> | null; level2: boolean | null; routes: Partial<Record<Task, string[] | null>>;
} = { env: {}, disabled: null, level2: null, routes: {} };

const dirty = () => Object.keys(draft.env).length > 0 || draft.disabled !== null || draft.level2 !== null || Object.keys(draft.routes).length > 0;

function resetDraft(): void {
  draft.env = {};
  draft.disabled = null;
  draft.level2 = null;
  draft.routes = {};
}

async function loadSettings(): Promise<void> {
  try {
    current = await api<SettingsResponse>('/api/settings');
    resetDraft();
    renderSettings();
    renderUi();
    renderCache();
  } catch (e) {
    if (!(e instanceof Unauthorized)) $('llm').innerHTML = `<p class="form-error">${esc((e as Error).message)}</p>`;
  }
}

function disabledSet(): Set<string> {
  return draft.disabled ?? new Set(current!.providers.filter((p) => p.disabled).map((p) => p.id));
}

function stateOf(p: ProviderStatus): [string, string] {
  if (!p.configured) return ['off', 'Non configuré'];
  if (disabledSet().has(p.id)) return ['off', 'Désactivé'];
  if (p.breakerOpenUntil) return ['warn', `En pause ${Math.ceil((p.breakerOpenUntil - Date.now()) / 60000)} min`];
  return p.available ? ['ok', 'Prêt'] : ['warn', 'Quota du jour atteint'];
}

function renderSettings(): void {
  const s = current!;
  $<HTMLInputElement>('level2').checked = draft.level2 ?? s.level2.enabled;
  const groups = new Map<string, ProviderStatus[]>();
  for (const p of s.providers) {
    const key = p.keyEnv ?? p.urlEnv ?? '';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const html = { llm: [] as string[], search: [] as string[] };
  for (const [envName, providers] of groups) html[providers[0]!.type].push(serviceHtml(envName, providers));
  $('llm').innerHTML = html.llm.join('');
  $('search').innerHTML = html.search.join('');
  $('routes').innerHTML = TASKS.map(([task, title, note]) => routeHtml(task, title, note)).join('');
  $('savebar').hidden = !dirty();
}

// ---------- order of the AIs, per task ----------

/** A task's order as it will be saved. */
function routeOf(task: Task): string[] {
  const r = current!.routes[task];
  const d = draft.routes[task];
  return d === null ? r.defaults : d ?? r.order;
}

/** Follows the default order: nothing saved by hand, or about to be reset. */
function routeIsDefault(task: Task): boolean {
  return draft.routes[task] === null || (draft.routes[task] === undefined && !current!.routes[task].custom);
}

function setRoute(task: Task, order: string[]): void {
  const r = current!.routes[task];
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (same(order, r.order)) delete draft.routes[task];
  else draft.routes[task] = order;
}

function routeHtml(task: Task, title: string, note: string): string {
  const order = routeOf(task);
  const llms = current!.providers.filter((p) => p.type === 'llm');
  const byId = new Map(llms.map((p) => [p.id, p]));
  const used = order.flatMap((id) => byId.get(id) ?? []);
  const unused = llms.filter((p) => !order.includes(p.id));
  const row = (p: ProviderStatus, k: number | null) => {
    const [cls, label] = stateOf(p);
    const svc = SERVICES[p.keyEnv ?? p.urlEnv ?? '']?.name ?? p.id;
    const move = (dir: number, sign: string, hint: string, off: boolean) =>
      `<button type="button" class="ghost route-move" data-route-move="${task}|${p.id}|${dir}" title="${hint}" aria-label="${hint}" ${off ? 'disabled' : ''}>${sign}</button>`;
    return `
      <li class="route-row${k === null ? ' unused' : ''}">
        <span class="route-rank">${k === null ? '' : k + 1}</span>
        <label class="check" title="${k === null ? 'Utiliser pour cette tâche' : 'Ne plus utiliser pour cette tâche'}">
          <input type="checkbox" data-route-use="${task}|${p.id}" ${k === null ? '' : 'checked'} />
          <span><b>${esc(svc)}</b> <span class="sub">${esc(p.model ?? p.defaultModel ?? '')}</span></span></label>
        <span class="state"><span class="dot ${cls}"></span>${esc(label)}</span>
        ${k === null ? '' : `${move(-1, '↑', 'Monter', k === 0)}${move(1, '↓', 'Descendre', k === used.length - 1)}`}
      </li>`;
  };
  const ready = used.some((p) => p.configured && !disabledSet().has(p.id));
  return `
    <div class="card route">
      <div class="service-head">
        <strong>${esc(title)}</strong>
        <span class="sub">${esc(note)}</span>
      </div>
      <ol class="route-list">${used.map((p, k) => row(p, k)).join('')}${unused.map((p) => row(p, null)).join('')}</ol>
      <div class="route-foot">
        <span class="sub">${ready ? '' : '⚠ Aucune IA configurée dans cet ordre : cette tâche ne se fera pas.'}</span>
        ${routeIsDefault(task) ? '<span class="sub">Ordre par défaut</span>' : `<button type="button" class="link" data-route-reset="${task}">Revenir à l’ordre par défaut</button>`}
      </div>
    </div>`;
}

function serviceHtml(envName: string, providers: ProviderStatus[]): string {
  const svc = SERVICES[envName] ?? { name: providers[0]!.id, note: '', field: envName.endsWith('_URL') ? 'Adresse' : 'Clé API' };
  const v = envName ? current!.variables[envName] : undefined;
  let field = '';
  if (envName && v) {
    const edited = envName in draft.env;
    const cleared = edited && draft.env[envName] === null;
    const status = cleared
      ? 'sera effacée à l’enregistrement'
      : v.source === 'settings' ? 'enregistrée ici'
        : v.source === 'env' ? 'définie par la variable du conteneur ; une valeur saisie ici la remplace' : '';
    const value = v.secret ? (edited && !cleared ? draft.env[envName]! : '') : edited ? (draft.env[envName] ?? '') : (v.value ?? '');
    const placeholder = v.secret
      ? cleared || !v.value ? 'Collez la clé ici' : `${v.value} · saisissez une nouvelle clé pour la remplacer`
      : (svc.placeholder ?? '');
    field = `
      <label class="field"><span>${esc(svc.field)}</span>
        <span class="field-row">
          <input data-var="${envName}" type="${v.secret ? 'password' : 'url'}" value="${esc(value)}"
            placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false" />
          ${v.source === 'settings' && !cleared ? `<button type="button" class="link" data-clear="${envName}">Effacer</button>` : ''}
        </span>
        ${status ? `<span class="sub">${esc(status)}</span>` : ''}
      </label>`;
  }
  const rows = providers.map((p) => {
    const [cls, label] = stateOf(p);
    const on = !disabledSet().has(p.id);
    const mv = p.modelEnv ? current!.variables[p.modelEnv] : undefined;
    const model = p.modelEnv
      ? `<input class="model" data-var="${p.modelEnv}" value="${esc(p.modelEnv in draft.env ? (draft.env[p.modelEnv] ?? '') : mv?.value ?? '')}"
           placeholder="${esc(p.defaultModel ?? 'modèle')}" title="Modèle (laisser vide pour ${esc(p.defaultModel ?? 'le défaut')})" spellcheck="false" />`
      : '';
    return `
      <div class="provider-row">
        <label class="check" title="Utiliser ce fournisseur"><input type="checkbox" data-provider="${p.id}" ${on ? 'checked' : ''} />
          <span>${esc(p.type === 'llm' ? (p.defaultModel ?? p.id) : p.id)}</span></label>
        ${model}
        <span class="quota">${nf.format(p.minute.limit)}/min · ${nf.format(p.day.limit)}/jour</span>
        <span class="state"><span class="dot ${cls}"></span>${esc(label)}</span>
        <button type="button" class="ghost" data-test="${p.id}">Tester</button>
        <span class="test-result" data-result="${p.id}"></span>
      </div>`;
  });
  return `
    <div class="service card">
      <div class="service-head">
        <strong>${esc(svc.name)}</strong>
        <span class="sub">${esc(svc.note)}${svc.link ? ` <a href="${svc.link}" target="_blank" rel="noopener">Obtenir une clé ↗</a>` : ''}</span>
      </div>
      ${field}
      <div class="provider-list">${rows.join('')}</div>
    </div>`;
}

const aiPanel = document.querySelector<HTMLElement>('[data-panel=ai]')!;

aiPanel.addEventListener('input', (e) => {
  const input = e.target as HTMLInputElement;
  const name = input.dataset.var;
  if (!name || !current) return;
  const v = current.variables[name]!;
  const val = input.value.trim();
  // Secrets: an empty box means "keep". Plain values: empty means "back to default".
  if (v.secret && !val) delete draft.env[name];
  else if (!v.secret && val === (v.value ?? '')) delete draft.env[name];
  else draft.env[name] = val || null;
  $('savebar').hidden = !dirty();
});

aiPanel.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (!current) return;
  if (input.id === 'level2') {
    draft.level2 = input.checked === current.level2.enabled ? null : input.checked;
  } else if (input.dataset.routeUse) {
    const [task, id] = input.dataset.routeUse.split('|') as [Task, string];
    const order = routeOf(task).filter((x) => x !== id);
    setRoute(task, input.checked ? [...order, id] : order);
    renderKeepingFocus();
    return;
  } else if (input.dataset.provider) {
    const set = new Set(disabledSet());
    if (input.checked) set.delete(input.dataset.provider);
    else set.add(input.dataset.provider);
    const saved = new Set(current.providers.filter((p) => p.disabled).map((p) => p.id));
    draft.disabled = set.size === saved.size && [...set].every((id) => saved.has(id)) ? null : set;
    renderKeepingFocus();
    return;
  }
  $('savebar').hidden = !dirty();
});

aiPanel.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  if (btn.dataset.clear) {
    draft.env[btn.dataset.clear] = null;
    renderKeepingFocus();
  } else if (btn.dataset.routeMove) {
    const [task, id, dir] = btn.dataset.routeMove.split('|') as [Task, string, string];
    const order = [...routeOf(task)];
    const i = order.indexOf(id);
    const j = i + Number(dir);
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    setRoute(task, order);
    renderSettings();
    // The arrow stays under the pointer's row: focus it again for keyboard moves.
    aiPanel.querySelector<HTMLButtonElement>(`[data-route-move="${task}|${id}|${dir}"]:not(:disabled)`)?.focus();
  } else if (btn.dataset.routeReset) {
    const task = btn.dataset.routeReset as Task;
    if (current!.routes[task].custom) draft.routes[task] = null;
    else delete draft.routes[task];
    renderSettings();
  } else if (btn.dataset.test) {
    const id = btn.dataset.test;
    if (dirty() && !(await save())) return;
    const out = aiPanel.querySelector<HTMLElement>(`[data-result="${id}"]`)!;
    const button = aiPanel.querySelector<HTMLButtonElement>(`[data-test="${id}"]`)!;
    button.disabled = true;
    out.className = 'test-result';
    out.textContent = 'Test en cours…';
    try {
      const r = await api<{ ok: boolean; ms: number; detail: string }>('/api/settings/test', { method: 'POST', body: { id } });
      out.className = `test-result ${r.ok ? 'ok' : 'bad'}`;
      out.textContent = `${r.ok ? '✓' : '✗'} ${r.detail} (${nf.format(r.ms)} ms)`;
    } catch (err) {
      out.className = 'test-result bad';
      out.textContent = `✗ ${(err as Error).message}`;
    } finally {
      button.disabled = false;
    }
  }
});

/** Re-render without losing what is being typed elsewhere. */
function renderKeepingFocus(): void {
  const active = document.activeElement as HTMLInputElement | null;
  const name = active?.dataset.var;
  renderSettings();
  if (name) aiPanel.querySelector<HTMLInputElement>(`[data-var="${name}"]`)?.focus();
}

async function save(): Promise<boolean> {
  const btn = $<HTMLButtonElement>('save');
  btn.disabled = true;
  $('save-msg').textContent = 'Enregistrement…';
  try {
    current = await api<SettingsResponse>('/api/settings', {
      method: 'PUT',
      body: {
        env: draft.env,
        ...(draft.disabled ? { disabled: [...draft.disabled] } : {}),
        ...(draft.level2 !== null ? { level2: draft.level2 } : {}),
        ...(Object.keys(draft.routes).length ? { routes: draft.routes } : {}),
      },
    });
    resetDraft();
    renderSettings();
    flash('Enregistré. Les nouveaux réglages s’appliquent tout de suite.');
    return true;
  } catch (err) {
    $('save-msg').textContent = `Échec : ${(err as Error).message}`;
    return false;
  } finally {
    btn.disabled = false;
  }
}

function flash(text: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

$('save').addEventListener('click', () => void save());
$('cancel').addEventListener('click', () => {
  resetDraft();
  renderSettings();
  $('save-msg').textContent = 'Modifications non enregistrées';
});
addEventListener('beforeunload', (e) => {
  if (dirty()) e.preventDefault();
});

// ---------- interface ----------

const SOUND_KINDS: [SoundKind, string, string][] = [
  ...(Object.keys(CATEGORY_LABELS) as Category[]).map((c): [SoundKind, string, string] => [c, CATEGORY_LABELS[c], CATEGORY_COLORS[c]]),
  ['territory', 'Territoire', '#d9a441'],
  ['army', 'Armée en campagne', '#c8554f'],
];
let imported: Record<string, string> = {};

function renderSounds(): void {
  $('sound-list').innerHTML = SOUND_KINDS.map(([k, label, color]) => `
    <div class="sound-row">
      <button type="button" class="ghost" data-sound="${k}" title="Écouter"><i style="background:${color}"></i>${esc(label)}</button>
      <span class="sound-src">${imported[k] ? 'Fichier importé' : 'Son d’origine'}</span>
      <label class="ghost sound-import" title="Importer un fichier audio (mp3, ogg, wav… 3 Mo au plus)">Importer…
        <input type="file" accept="audio/*" data-import="${k}" hidden>
      </label>
      ${imported[k] ? `<button type="button" class="ghost" data-reset="${k}" title="Revenir au son d’origine">Rétablir</button>` : ''}
    </div>`).join('');
}

async function sendSound(kind: string, file: File | null): Promise<void> {
  const r = await fetch(`/api/admin/sounds/${kind}`, file
    ? { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }
    : { method: 'DELETE' });
  if (r.status === 401) {
    showLogin();
    return;
  }
  const data = (await r.json().catch(() => ({}))) as Record<string, string> & { error?: string };
  if (!r.ok) {
    flash(`Échec : ${data.error ?? r.status}`);
    return;
  }
  imported = data;
  await loadCustomSounds();
  renderSounds();
  flash(file ? 'Son importé.' : 'Son d’origine rétabli.');
}

const percent = (v: number) => `${Math.round(v * 100)} %`;

function renderUi(): void {
  const ui = current!.ui;
  configureSounds(ui);
  $<HTMLInputElement>('sounds').checked = ui.sounds;
  $<HTMLInputElement>('volume').value = String(ui.volume);
  $('volume-value').textContent = percent(ui.volume);
  $<HTMLInputElement>('hover-open').checked = ui.hoverOpen;
  $<HTMLInputElement>('meanwhile-span').value = String(ui.meanwhileMaxSpan);
  renderSounds();
  void loadCustomSounds().then((c) => {
    imported = c;
    renderSounds();
  });
}

let uiTimer: number | undefined;
/** Interface preferences save on their own, a moment after the last change. */
function saveUi(): void {
  const span = Number($<HTMLInputElement>('meanwhile-span').value);
  const ui: UiPrefs = {
    sounds: $<HTMLInputElement>('sounds').checked,
    volume: Number($<HTMLInputElement>('volume').value),
    hoverOpen: $<HTMLInputElement>('hover-open').checked,
    meanwhileMaxSpan: Number.isFinite(span) && span >= 0 ? Math.min(10000, Math.round(span)) : current!.ui.meanwhileMaxSpan,
  };
  configureSounds(ui);
  $('volume-value').textContent = percent(ui.volume);
  clearTimeout(uiTimer);
  uiTimer = window.setTimeout(async () => {
    try {
      const res = await api<SettingsResponse>('/api/settings', { method: 'PUT', body: { ui } });
      current = { ...current!, ui: res.ui };
      flash('Enregistré.');
    } catch (err) {
      if (!(err instanceof Unauthorized)) flash(`Échec : ${(err as Error).message}`);
    }
  }, 400);
}

$('sounds').addEventListener('change', saveUi);
$('volume').addEventListener('input', saveUi);
$('hover-open').addEventListener('change', saveUi);
$('meanwhile-span').addEventListener('change', saveUi);
$('sound-list').addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const kind = el.closest<HTMLElement>('[data-sound]')?.dataset.sound as SoundKind | undefined;
  if (kind) playSound(kind, { force: true });
  const reset = el.closest<HTMLElement>('[data-reset]')?.dataset.reset;
  if (reset) void sendSound(reset, null);
});
$('sound-list').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const kind = input.dataset.import;
  const file = input.files?.[0];
  if (!kind || !file) return;
  if (file.size > 3 * 1024 * 1024) flash('Fichier trop lourd : 3 Mo au plus.');
  else void sendSound(kind, file);
  input.value = '';
});

// ---------- cache ----------

/** Budget steps of the slider, in GB. */
const GB_STEPS = [0.5, 1, 2, 3, 5, 10, 15, 20, 30, 50, 75, 100];
const gbLabel = (gb: number) => `${gbf.format(gb)} Go`;

function renderCache(): void {
  const c = current!.cache;
  const i = GB_STEPS.findIndex((g) => g >= c.maxGb);
  $<HTMLInputElement>('cache-size').value = String(i < 0 ? GB_STEPS.length - 1 : i);
  $('cache-size-value').textContent = gbLabel(c.maxGb);
  $<HTMLSelectElement>('cache-refresh').value = String(c.refreshDays);
  // A value set by hand in settings.json may not be in the list.
  if ($<HTMLSelectElement>('cache-refresh').value !== String(c.refreshDays)) $<HTMLSelectElement>('cache-refresh').value = '180';
  $<HTMLInputElement>('cache-images').checked = c.images;
}

function renderCacheUsage(d: AdminResponse): void {
  const used = d.cache.bytes + d.cache.media.bytes;
  $('cache-usage').innerHTML = [
    card('Utilisé', size(used), `sur ${size(d.cache.maxBytes)}`),
    card('Points', nf.format(d.pois), size(d.cache.bytes)),
    card('Images', nf.format(d.cache.media.count), size(d.cache.media.bytes)),
  ].join('');
}

let cacheTimer: number | undefined;
function saveCache(): void {
  const gb = GB_STEPS[Number($<HTMLInputElement>('cache-size').value)] ?? 10;
  const cache: CachePrefs = {
    maxGb: gb,
    refreshDays: Number($<HTMLSelectElement>('cache-refresh').value),
    images: $<HTMLInputElement>('cache-images').checked,
  };
  $('cache-size-value').textContent = gbLabel(gb);
  clearTimeout(cacheTimer);
  cacheTimer = window.setTimeout(async () => {
    try {
      const res = await api<SettingsResponse>('/api/settings', { method: 'PUT', body: { cache } });
      current = { ...current!, cache: res.cache };
      flash('Enregistré.');
      void refreshStatus();
    } catch (err) {
      if (!(err instanceof Unauthorized)) flash(`Échec : ${(err as Error).message}`);
    }
  }, 500);
}

$('cache-size').addEventListener('input', saveCache);
$('cache-refresh').addEventListener('change', saveCache);
$('cache-images').addEventListener('change', saveCache);
$('cache-clear-media').addEventListener('click', async () => {
  if (!confirm('Vider le cache des images ? Elles seront redemandées à Wikimedia au besoin.')) return;
  try {
    await api('/api/admin/media', { method: 'DELETE' });
    flash('Cache des images vidé.');
    void refreshStatus();
  } catch (err) {
    if (!(err instanceof Unauthorized)) flash(`Échec : ${(err as Error).message}`);
  }
});

// ---------- status ----------

const MODE: Record<AdminResponse['level2']['mode'], [string, string]> = {
  active: ['ok', 'Actif'],
  degraded: ['warn', 'Dégradé : quotas épuisés ou fournisseurs en pause, seuls Wikipédia, Wikidata et le cache servent'],
  'no-llm': ['off', 'Aucune IA configurée : ajoutez une clé dans l’onglet Recherche IA'],
  off: ['off', 'Désactivé dans l’onglet Recherche IA'],
};

function card(label: string, value: string, sub = ''): string {
  return `<div class="card"><div class="card-label">${label}</div><div class="card-value">${value}</div><div class="card-sub">${sub}</div></div>`;
}

function meter(used: number, limit: number): string {
  const pct = Math.min(100, (used / Math.max(1, limit)) * 100);
  return `<div class="meter"><i style="width:${pct}%" class="${pct >= 90 ? 'hot' : ''}"></i></div><span class="num">${nf.format(used)} / ${nf.format(limit)}</span>`;
}

function state(p: ProviderStatus): string {
  if (!p.configured) return '<span class="dot off"></span>Non configuré';
  if (p.disabled) return '<span class="dot off"></span>Désactivé';
  if (p.breakerOpenUntil) {
    const min = Math.ceil((p.breakerOpenUntil - Date.now()) / 60000);
    return `<span class="dot warn"></span>En pause (${min} min)`;
  }
  return p.available ? '<span class="dot ok"></span>Disponible' : '<span class="dot warn"></span>Quota atteint';
}

const pct = (n: number, of: number) => `${of ? Math.round((n / of) * 100) : 0} %`;

function renderStatus(d: AdminResponse): void {
  const q2 = d.queue.level2;
  $('summary').innerHTML = [
    card('Points en cache', nf.format(d.pois), `${size(d.cache.bytes + d.cache.media.bytes)} sur ${size(d.cache.maxBytes)} (images comprises)`),
    card('Zones cherchées', nf.format(d.keys.done), `${d.keys.pending + d.keys.partial} en cours · ${d.keys.failed} en échec`),
    card('File de recherche', nf.format(d.queue.waiting), `${d.queue.active} en cours${q2 ? ` · niveau 2 : ${q2.waiting + q2.active}` : ''}`),
    card('Territoires complétés', `${pct(d.realms.emblems, d.realms.realms)} blasons`,
      `${pct(d.realms.named, d.realms.realms)} noms français · ${pct(d.realms.faiths, d.realms.realms)} religions, sur ${nf.format(d.realms.realms)} États (complété en arrière-plan)${d.realms.watched ? ` · ${nf.format(d.realms.watched)} suivis de près` : ''}`),
    card('Stockage', d.mode.store === 'embedded-postgres' ? 'Postgres intégré' : d.mode.store, `file ${d.mode.queue}`),
  ].join('');

  const [cls, text] = MODE[d.level2.mode];
  $('level2-hint').innerHTML = `<span class="dot ${cls}"></span>${esc(text)}`;

  const rows = d.level2.providers.map(
    (p) => `<tr class="${p.configured && !p.disabled ? '' : 'muted'}">
      <td><strong>${esc(p.id)}</strong><div class="sub">${p.type === 'llm' ? `IA · ${esc(p.model ?? '')}` : 'Recherche'}</div></td>
      <td>${state(p)}</td>
      <td>${meter(p.minute.used, p.minute.limit)}</td>
      <td>${meter(p.day.used, p.day.limit)}</td>
      <td class="num">${nf.format(p.calls)}${p.failures ? ` <span class="bad">(${nf.format(p.failures)} échecs)</span>` : ''}</td>
      <td class="num">${p.avgLatencyMs != null ? `${nf.format(p.avgLatencyMs)} ms` : '—'}</td>
      <td class="err">${p.lastError ? esc(p.lastError) : ''}</td>
    </tr>`,
  );
  $('providers').innerHTML = `
    <thead><tr><th>Fournisseur</th><th>État</th><th>Minute</th><th>Jour</th><th>Appels</th><th>Latence</th><th>Dernière erreur</th></tr></thead>
    <tbody>${rows.join('')}</tbody>`;
}

let statusTimer: ReturnType<typeof setInterval> | null = null;

async function refreshStatus(): Promise<void> {
  try {
    const d = await api<AdminResponse>('/api/admin/providers');
    renderStatus(d);
    renderCacheUsage(d);
  } catch (e) {
    if (!(e instanceof Unauthorized)) $('level2-hint').textContent = 'Serveur injoignable.';
  }
}

function startStatus(): void {
  if (statusTimer) return;
  void refreshStatus();
  statusTimer = setInterval(refreshStatus, 5000);
}

function stopStatus(): void {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
}

// ---------- account ----------

$('password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
  const error = $('password-error');
  error.textContent = '';
  if (data.next !== data.confirm) {
    error.textContent = 'Les deux mots de passe ne correspondent pas.';
    return;
  }
  try {
    await api('/api/auth/password', { method: 'POST', body: { current: data.current, next: data.next } });
    form.reset();
    $('default-password').hidden = true;
    flash('Mot de passe changé.');
  } catch (err) {
    if (!(err instanceof Unauthorized)) error.textContent = (err as Error).message;
  }
});

// ---------- start ----------

api<{ user: string; defaultPassword: boolean }>('/api/auth/me').then(showApp, () => {});
