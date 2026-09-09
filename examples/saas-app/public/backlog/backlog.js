/**
 * The ranked backlog, over the read API.
 *
 * Three endpoints, no client-side ranking logic whatsoever:
 *
 *   GET /v0/issues                    the ordered list, with score components
 *   GET /v0/issues/:id/submissions    the verbatim evidence, on demand
 *   GET /v0/health                    how much is in the store
 *
 * The design constraint this page is built to satisfy is ADR-0012: **a ranked
 * list a reader cannot interrogate is one nobody believes.** So the score
 * breakdown is not hidden behind a tooltip, the quotes are not a summary, and
 * nothing on screen is a number this page computed for itself. Every value
 * shown is a field the API returned, which is why there is no arithmetic in
 * this file.
 *
 * Evidence loads per row rather than with the list, because a cluster can have
 * thousands of members and the list view must not carry them.
 */

const list = document.getElementById('list');
const crumb = document.getElementById('crumb');

document.getElementById('refresh').addEventListener('click', () => void load());

async function load() {
  list.innerHTML = '<p class="empty">Loading…</p>';

  let payload;
  try {
    const response = await fetch('/v0/issues?limit=20');
    if (!response.ok) throw new Error(`the API answered ${response.status}`);
    payload = await response.json();
  } catch (error) {
    list.innerHTML = `<p class="error">Could not reach the API — ${escape(String(error))}<br />
      Is <code>npm run app</code> still running?</p>`;
    crumb.textContent = 'disconnected';
    return;
  }

  const health = await fetch('/v0/health')
    .then((r) => r.json())
    .catch(() => ({ submissions: '?' }));

  // Stated rather than implied: these are computed per request, not read from
  // a table, which bounds both how fresh they are and what they cost.
  crumb.textContent = `${payload.issues.length} issues from ${health.submissions} submissions · computed ${time(payload.computedAt)}`;

  if (payload.issues.length === 0) {
    list.innerHTML = '<p class="empty">Nothing yet. Send some feedback from the app.</p>';
    return;
  }

  list.replaceChildren(...payload.issues.map((issue, index) => renderIssue(issue, index + 1)));
}

function renderIssue(issue, rank) {
  const node = document.createElement('details');
  node.className = 'issue';

  const kinds = Object.entries(issue.kinds)
    .map(([kind, count]) => tag(`${kind} ×${count}`))
    .join('');
  const route =
    issue.topRoute === undefined
      ? ''
      : tag(`${issue.topRoute.route} · ${Math.round(issue.topRoute.share * 100)}% of members`);

  node.innerHTML = `
    <summary>
      <span class="rank">${rank}</span>
      <span class="score">${issue.score.toFixed(2)}</span>
      <span>
        <span class="title">${escape(issue.title)}</span>
        <div class="why">${escape(issue.explanation)}</div>
        <div class="tags">${kinds}${route}</div>
      </span>
    </summary>
    <div class="detail">
      <div class="components">
        ${component('unique users', issue.uniqueUsers)}
        ${component('submissions', issue.submissionCount)}
        ${component('weighted demand', issue.components.weightedDemand.toFixed(2))}
        ${component('mean account weight', issue.components.meanAccountWeight.toFixed(2))}
        ${component('growth', growth(issue.components))}
      </div>
      <div data-evidence><p class="empty">Loading evidence…</p></div>
    </div>`;

  // Fetched on first expand, once. The list view stays cheap and the drill-down
  // is still always available, which is the requirement.
  node.addEventListener(
    'toggle',
    () => {
      if (node.open) void loadEvidence(issue, node.querySelector('[data-evidence]'));
    },
    { once: true },
  );

  return node;
}

async function loadEvidence(issue, target) {
  // The quotes already on the list render immediately; the full set replaces
  // them when it arrives, so expanding never shows an empty box.
  target.innerHTML = issue.quotes.map(quote).join('');

  try {
    const response = await fetch(`/v0/issues/${encodeURIComponent(issue.id)}/submissions`);
    if (!response.ok) throw new Error(String(response.status));

    const { submissions, total } = await response.json();
    target.innerHTML =
      `<p class="why">${total} submission${total === 1 ? '' : 's'} in this cluster</p>` +
      submissions
        .map((submission) =>
          quote({
            body: submission.body,
            submissionId: submission.id,
            clientTs: submission.clientTs,
            source: submission.source,
            isLabel: issue.quotes.some((q) => q.submissionId === submission.id && q.isLabel),
            attributed: submission.attributed,
            route: submission.route,
          }),
        )
        .join('');
  } catch {
    // The list-view quotes are still on screen, so this degrades to fewer
    // quotes rather than to nothing.
    target.insertAdjacentHTML('beforeend', '<p class="why">Could not load the full evidence.</p>');
  }
}

function quote(q) {
  const meta = [
    q.submissionId,
    q.clientTs === undefined ? undefined : q.clientTs.slice(0, 10),
    q.source,
    q.route,
    q.attributed === false ? 'unattributed' : undefined,
  ]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');

  return `<blockquote class="${q.isLabel ? 'label' : ''}">
    <p>${escape(q.body)}</p>
    <div class="meta">${escape(meta)}${q.isLabel ? ' · used as the title' : ''}</div>
  </blockquote>`;
}

function component(label, value) {
  return `<div><div class="k">${label}</div><div class="v">${value}</div></div>`;
}

/**
 * The second derivative is what a PM actually wants, so it gets said plainly —
 * including when it was withheld.
 *
 * `growthSuppressed` means the prior window did not clear the volume floor. A
 * multiplier from two users to four is noise, and presenting it as ×2 growth
 * is how a ranked list ends up led by whatever happened to arrive on Tuesday.
 */
function growth(c) {
  if (c.growthSuppressed) return `n/a · only ${c.priorUsers} prior`;
  return `×${c.growthMultiplier.toFixed(2)} (${c.recentUsers} ← ${c.priorUsers})`;
}

function tag(text) {
  return `<span class="tag">${escape(text)}</span>`;
}

function time(iso) {
  return new Date(iso).toLocaleTimeString();
}

function escape(text) {
  return String(text).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

void load();
