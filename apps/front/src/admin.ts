import '@fontsource/eb-garamond/500.css';
import '@fontsource-variable/inter';
import './admin.css';

// Admin page (brief §8.4, observability): quotas, breakers, queue and cache.

interface ProviderStatus {
  id: string;
  type: 'search' | 'llm';
  model: string | null;
  configured: boolean;
  available: boolean;
  minute: { used: number; limit: number };
  day: { used: number; limit: number };
  breakerOpenUntil: number | null;
  calls: number;
  failures: number;
  avgLatencyMs: number | null;
  lastError: string | null;
}

interface AdminResponse {
  mode: { store: string; queue: string };
  queue: { waiting: number; active: number; level2?: { waiting: number; active: number } };
  keys: Record<'pending' | 'done' | 'partial' | 'failed', number>;
  pois: number;
  cache: { bytes: number; maxBytes: number };
  level2: { enabled: boolean; mode: 'active' | 'degraded' | 'no-llm' | 'off'; providers: ProviderStatus[] };
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const nf = new Intl.NumberFormat('fr-FR');
const mb = (b: number) => `${nf.format(Math.round(b / 1048576))} Mo`;

const MODE: Record<AdminResponse['level2']['mode'], [string, string]> = {
  active: ['ok', 'Actif'],
  degraded: ['warn', 'Dégradé : quotas épuisés ou fournisseurs en pause, seuls Wikipédia, Wikidata et le cache servent'],
  'no-llm': ['off', 'Aucune IA configurée : ajoutez une clé (GEMINI_API_KEY, GROQ_API_KEY…)'],
  off: ['off', 'Désactivé (LEVEL2=off)'],
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
  if (p.breakerOpenUntil) {
    const min = Math.ceil((p.breakerOpenUntil - Date.now()) / 60000);
    return `<span class="dot warn"></span>En pause (${min} min)`;
  }
  return p.available ? '<span class="dot ok"></span>Disponible' : '<span class="dot warn"></span>Quota atteint';
}

function render(d: AdminResponse): void {
  const q2 = d.queue.level2;
  document.getElementById('summary')!.innerHTML = [
    card('Points en cache', nf.format(d.pois), `${mb(d.cache.bytes)} sur ${mb(d.cache.maxBytes)}`),
    card('Zones explorées', nf.format(d.keys.done), `${d.keys.pending + d.keys.partial} en cours · ${d.keys.failed} en échec`),
    card('File de recherche', nf.format(d.queue.waiting), `${d.queue.active} en cours${q2 ? ` · niveau 2 : ${q2.waiting + q2.active}` : ''}`),
    card('Stockage', d.mode.store === 'embedded-postgres' ? 'Postgres intégré' : d.mode.store, `file ${d.mode.queue}`),
  ].join('');

  const [cls, text] = MODE[d.level2.mode];
  document.getElementById('level2-hint')!.innerHTML = `<span class="dot ${cls}"></span>${esc(text)}`;

  const rows = d.level2.providers.map(
    (p) => `<tr class="${p.configured ? '' : 'muted'}">
      <td><strong>${esc(p.id)}</strong><div class="sub">${p.type === 'llm' ? `IA · ${esc(p.model ?? '')}` : 'Recherche'}</div></td>
      <td>${state(p)}</td>
      <td>${meter(p.minute.used, p.minute.limit)}</td>
      <td>${meter(p.day.used, p.day.limit)}</td>
      <td class="num">${nf.format(p.calls)}${p.failures ? ` <span class="bad">(${nf.format(p.failures)} échecs)</span>` : ''}</td>
      <td class="num">${p.avgLatencyMs != null ? `${nf.format(p.avgLatencyMs)} ms` : '—'}</td>
      <td class="err">${p.lastError ? esc(p.lastError) : ''}</td>
    </tr>`,
  );
  document.getElementById('providers')!.innerHTML = `
    <thead><tr><th>Fournisseur</th><th>État</th><th>Minute</th><th>Jour</th><th>Appels</th><th>Latence</th><th>Dernière erreur</th></tr></thead>
    <tbody>${rows.join('')}</tbody>`;
  document.getElementById('updated')!.textContent = `mis à jour à ${new Date().toLocaleTimeString('fr-FR')}`;
}

async function refresh(): Promise<void> {
  try {
    const r = await fetch('/api/admin/providers');
    render((await r.json()) as AdminResponse);
  } catch {
    document.getElementById('updated')!.textContent = 'serveur injoignable';
  }
}

void refresh();
setInterval(refresh, 5000);
