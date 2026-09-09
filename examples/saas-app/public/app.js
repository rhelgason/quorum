/**
 * Northwind Analytics — the fake product.
 *
 * Everything here is scaffolding for the four lines that matter, all of them
 * marked below:
 *
 *   1. `defineQuorumNub()` — register the element.
 *   2. `nub.identify(id, { mrr })` — the call that makes ranking
 *      revenue-weighted instead of a head count.
 *   3. `nub.reset()` — on sign-out.
 *   4. listening for `quorum:queued` — so the app can say something honest
 *      when a submission is saved offline.
 *
 * Real URLs, not hash routes, because the nub reads `location.pathname` and a
 * hash-routed page would tag every submission `/`.
 */

import { defineQuorumNub } from '/packages/web/src/index.ts';

// 1. Register. Importing the module deliberately does not do this for you.
defineQuorumNub();

const nub = document.querySelector('quorum-nub');

// ---------------------------------------------------------------------------
// Who is using the app
// ---------------------------------------------------------------------------

/**
 * Three personas with very different account weights.
 *
 * The point of the switcher: file the same feedback as Dana and as Priya, then
 * look at the backlog. One submission from a $9,400/mo account outranks
 * several from free users — but only by a few multiples, because weighting is
 * logarithmic and a linear one would make the roadmap "whatever the whale
 * wants" (ADR-0015).
 */
const USERS = [
  { id: 'cust_027', name: 'Priya (Vertex Group)', plan: 'enterprise', mrr: 9400 },
  { id: 'cust_004', name: 'Marco (Halden Co)', plan: 'team', mrr: 240 },
  { id: 'cust_011', name: 'Dana (free)', plan: 'free', mrr: 0 },
  { id: '', name: 'Signed out', plan: 'anonymous', mrr: 0 },
];

const select = document.getElementById('user');
const planLabel = document.getElementById('plan');

for (const user of USERS) {
  const option = document.createElement('option');
  option.value = user.id;
  option.textContent = user.name;
  select.append(option);
}

function signIn(id) {
  const user = USERS.find((candidate) => candidate.id === id) ?? USERS[USERS.length - 1];
  planLabel.textContent = user.id === '' ? 'anonymous' : `${user.plan} · $${user.mrr}/mo`;

  if (user.id === '') {
    // 3. Sign-out. Submissions fall back to the stable per-project anonymous
    //    id, which still counts as one user — it just carries no weight.
    nub.reset();
    return;
  }

  // 2. The one call that makes the ranked list revenue-weighted. `mrr` is the
  //    trait ranking reads; everything else rides along for the reader.
  nub.identify(user.id, { plan: user.plan, mrr: user.mrr });
}

select.addEventListener('change', () => signIn(select.value));
select.value = USERS[0].id;
signIn(USERS[0].id);

// ---------------------------------------------------------------------------
// Feedback the app itself reacts to
// ---------------------------------------------------------------------------

// 4. `queued` is not an error. It means the submission is durable on the
//    device and will go out on the next flush, which is what should be said
//    to someone who filed feedback on a train.
document.addEventListener('quorum:queued', (event) => {
  toast(`Saved offline — ${event.detail.queueDepth} waiting to send.`);
});

document.addEventListener('quorum:submit', (event) => {
  console.info('[northwind] submitted', event.detail.id);
});

function toast(message) {
  const node = document.createElement('div');
  node.textContent = message;
  node.style.cssText =
    'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#0f172a;' +
    'color:#fff;padding:9px 14px;border-radius:8px;font:14px/1.4 system-ui;z-index:9';
  document.body.append(node);
  setTimeout(() => node.remove(), 4000);
}

// ---------------------------------------------------------------------------
// The product itself — scaffolding from here down
// ---------------------------------------------------------------------------

const VIEWS = {
  '/': () => `
    <h1>Dashboard</h1>
    <p class="lede">Last 30 days across all workspaces.</p>
    <div class="cards">
      ${card('Active users', '12,481', '+4.2%')}
      ${card('Events ingested', '3.1M', '+11.8%')}
      ${card('p95 query time', '1.8s', '−0.3s')}
      ${card('Retention', '91%', '+0.6pt')}
    </div>
    <div class="chart">
      <strong>Weekly active users</strong>
      <div class="bars">${bars([52, 61, 58, 70, 74, 69, 83, 91])}</div>
    </div>`,

  '/reports': () => `
    <h1>Reports</h1>
    <p class="lede">Scheduled and saved reports.</p>
    <table>
      <thead><tr><th>Name</th><th>Schedule</th><th>Last run</th><th></th></tr></thead>
      <tbody>
        ${row('Weekly revenue', 'Mondays 08:00', '2 days ago')}
        ${row('Churn cohort', 'Monthly', '11 days ago')}
        ${row('Funnel breakdown', 'Manual', 'never')}
      </tbody>
    </table>
    <p style="margin-top:14px"><button class="btn primary">Export CSV</button></p>`,

  '/settings': () => `
    <h1>Settings</h1>
    <p class="lede">Workspace preferences.</p>
    <table>
      <tbody>
        ${row('Workspace name', 'Northwind Analytics', '')}
        ${row('Timezone', 'Europe/Lisbon', '')}
        ${row('Appearance', 'Light', '')}
      </tbody>
    </table>`,

  '/settings/security': () => `
    <h1>Security</h1>
    <p class="lede">Authentication and access.</p>
    <table>
      <tbody>
        ${row('Two-factor', 'Required', '')}
        ${row('SAML SSO', 'Not configured', '')}
        ${row('Session length', '12 hours', '')}
      </tbody>
    </table>`,
};

function card(k, v, d) {
  return `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
}

function bars(values) {
  return values.map((v) => `<div style="height:${v}%"></div>`).join('');
}

function row(a, b, c) {
  return `<tr><td>${a}</td><td>${b}</td><td>${c}</td></tr>`;
}

const view = document.getElementById('view');
const crumb = document.getElementById('crumb');

function render() {
  const path = location.pathname;
  const draw = VIEWS[path] ?? VIEWS['/'];

  view.innerHTML = `${draw()}
    <p class="hint">
      Nothing on this page is real except the widget. Press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>K</kbd>
      or use the nub in the corner — the submission is tagged
      <code>${path}</code> and version <code>4.12.0</code>, then clustered
      against the seeded support inbox. See it land in the
      <a href="/backlog">product backlog</a>.
    </p>`;

  crumb.textContent = path;
  for (const link of document.querySelectorAll('#nav a[data-route]')) {
    if (link.dataset.route === path) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

document.getElementById('nav').addEventListener('click', (event) => {
  const link = event.target.closest('a[data-route]');
  if (link === null) return;
  event.preventDefault();
  // pushState rather than a hash, so `location.pathname` is the real route.
  history.pushState({}, '', link.getAttribute('href'));
  render();
});

addEventListener('popstate', render);
render();
