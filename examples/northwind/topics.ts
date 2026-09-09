/**
 * The feedback catalogue for Northwind Analytics, a product that does not
 * exist.
 *
 * ## This is synthetic, and that is a limitation not a disclaimer
 *
 * Every sentence below was written to populate a demo. It is useful for
 * showing the pipeline at scale — compression, the long tail, revenue
 * weighting reordering a list, a regression appearing after a release — and it
 * is **not** evidence that clustering works, because the person who wrote the
 * paraphrases also knows which cluster each belongs to. `packages/eval` keeps
 * a separate labeled corpus for measurement, and
 * [its README](../../packages/eval/README.md) is equally blunt that replacing
 * *that* with real data is the highest-leverage task in the track.
 *
 * ## What the paraphrases are trying to do
 *
 * Make the clusterer work. Feedback about one thing rarely shares vocabulary:
 * "add dark mode", "the app is blinding at night" and "why is everything so
 * white" are one item and share no content words. Every topic here therefore
 * includes at least one phrasing with **no lexical overlap** with its
 * siblings — those are the ones lexical clustering provably cannot catch, and
 * the reason embeddings are on the roadmap. A corpus where every paraphrase
 * repeats the same nouns would make the ranked list look far better than the
 * product is.
 *
 * Topics are also deliberately adjacent in places — `csv-export-timeout` next
 * to `scheduled-reports-missing`, `sso-saml` next to `scim-provisioning` —
 * because over-merging is as wrong as under-merging and a corpus of obviously
 * distinct subjects would never show it.
 */

export type Shape =
  /** Roughly constant over the window. */
  | 'steady'
  /** Accelerating — the growth multiplier should notice. */
  | 'growing'
  /** Nothing, then a wall of reports after a release. */
  | 'regression'
  /** Loud early, then quiet. Someone shipped a fix. */
  | 'fading'
  /** A handful, forever. The long tail the ranked list has to keep out of the top. */
  | 'trickle';

export interface Topic {
  id: string;
  kind: 'bug' | 'feature_request' | 'question' | 'praise';
  route: string;
  shape: Shape;
  /** Roughly how many reports to generate. */
  volume: number;
  /**
   * Bias toward paying accounts, 0..1. Procurement blockers come from
   * enterprises; complaints about the free tier's limits do not.
   */
  enterpriseBias: number;
  /** Only for `regression` — the release that broke it. */
  brokenIn?: string;
  phrasings: string[];
}

export const TOPICS: Topic[] = [
  {
    id: 'csv-export-timeout',
    kind: 'bug',
    route: '/reports',
    shape: 'growing',
    volume: 34,
    enterpriseBias: 0.6,
    phrasings: [
      'The CSV export on the reports page just spins forever and never downloads.',
      'csv export is broken, I click download and nothing happens',
      'Export to CSV times out every single time on our larger workspaces.',
      'Downloading a report as a spreadsheet fails silently.',
      'I hit export and then wait, and wait, and eventually give up.',
      'The download never arrives. No error, no file, nothing in my downloads folder.',
      'Exporting a quarter of data just hangs the tab.',
      'Any report over about 50k rows will not come out of the system.',
      'We cannot get our data out. That is a serious problem for us.',
      'The spinner on the export button never stops.',
    ],
  },
  {
    id: 'dark-mode',
    kind: 'feature_request',
    route: '/dashboard',
    shape: 'growing',
    volume: 41,
    enterpriseBias: 0.2,
    phrasings: [
      'Please add a dark mode.',
      'dark mode, dark mode, dark mode. Please.',
      'Any chance of a darker theme?',
      'Why is everything so white? It is blinding.',
      'Staring at this all day genuinely hurts my eyes.',
      'I use this at night and it lights up the whole room.',
      'Every other tool we use has a night theme now.',
      'Could the interface respect my system appearance setting?',
      'The contrast is brutal after about 6pm.',
      'A low-light option would make this so much more pleasant to live in.',
    ],
  },
  {
    id: 'scan-crash-ios',
    kind: 'bug',
    route: '/mobile/capture',
    shape: 'regression',
    volume: 28,
    enterpriseBias: 0.35,
    brokenIn: '4.12.0',
    phrasings: [
      'The scan button crashes the app instantly on my iPhone.',
      'App closes itself the moment I open the camera.',
      'scanner crash, iOS 18.2, iPhone 14',
      'Tapping capture kills the whole app every time since the update.',
      'It quit on me four times in a row trying to photograph a receipt.',
      'Camera screen = immediate crash. Was fine last week.',
      'Since the latest release I cannot photograph anything without it dying.',
      'The app disappears when I try to use the camera.',
    ],
  },
  {
    id: 'sso-saml',
    kind: 'feature_request',
    route: '/settings/security',
    shape: 'steady',
    volume: 19,
    enterpriseBias: 0.95,
    phrasings: [
      'We need SAML SSO before we can roll this out to the wider org.',
      'Checking in on SAML SSO timing, procurement is waiting on us.',
      'Our security team will not approve another tool without single sign-on.',
      'Is Okta integration on the roadmap? It is a hard requirement here.',
      'Managing passwords for 200 people is not something we are willing to do.',
      'Identity federation is a blocker for the enterprise agreement.',
      'We cannot expand seats until login goes through our own provider.',
    ],
  },
  {
    id: 'scim-provisioning',
    kind: 'feature_request',
    route: '/settings/team',
    shape: 'trickle',
    volume: 9,
    enterpriseBias: 0.9,
    phrasings: [
      'Do you support SCIM for automatic user provisioning?',
      'We need people deprovisioned automatically when they leave.',
      'Adding and removing seats by hand does not scale for us.',
      'Directory sync would save our IT team a lot of tickets.',
    ],
  },
  {
    id: 'dashboard-slow',
    kind: 'bug',
    route: '/dashboard',
    shape: 'growing',
    volume: 37,
    enterpriseBias: 0.5,
    phrasings: [
      'The dashboard is so slow to load now, it used to be instant.',
      'Dashboard loading slow, timing out on our office wifi.',
      'Takes about fifteen seconds before I can see anything.',
      'Performance has fallen off a cliff in the last month.',
      'I make a coffee while the home screen loads.',
      'The first page after login is painfully sluggish.',
      'Everything hangs for ages before the charts appear.',
      'It was snappy when we signed up and it is not any more.',
      'Loading times have roughly tripled since the spring.',
    ],
  },
  {
    id: 'scheduled-reports-missing',
    kind: 'bug',
    route: '/reports',
    shape: 'steady',
    volume: 16,
    enterpriseBias: 0.55,
    phrasings: [
      'Scheduled reports never arrive in my inbox.',
      'The Monday email has not turned up for three weeks.',
      'I set up a recurring report and it has never once sent.',
      'Automated delivery seems to just silently not happen.',
      'My team stopped getting the weekly summary and nobody changed anything.',
    ],
  },
  {
    id: 'timezone-wrong',
    kind: 'bug',
    route: '/reports',
    shape: 'steady',
    volume: 14,
    enterpriseBias: 0.3,
    phrasings: [
      'All my timestamps are showing in the wrong timezone.',
      'The date picker saves the wrong day.',
      'Everything is offset by several hours from what actually happened.',
      'Reports are attributing yesterday evening to today.',
      'We are in Sydney and the numbers do not line up with our day.',
    ],
  },
  {
    id: 'bulk-approve',
    kind: 'feature_request',
    route: '/approvals',
    shape: 'steady',
    volume: 22,
    enterpriseBias: 0.45,
    phrasings: [
      'Let me select all and approve, that is all I want.',
      'Clicking approve forty times in a row is painful.',
      'There is no way to action more than one item at once.',
      'Please add checkboxes so I can handle a batch together.',
      'Doing these one by one takes my entire Friday afternoon.',
      'Multi-select would save me hours every month.',
    ],
  },
  {
    id: 'search-missing',
    kind: 'feature_request',
    route: '/dashboard',
    shape: 'growing',
    volume: 18,
    enterpriseBias: 0.35,
    phrasings: [
      'There is no way to search my data.',
      'How do I find one specific record? I cannot see a search box anywhere.',
      'Please add a way to filter by keyword.',
      'Scrolling is the only way to locate anything, which is rough at our volume.',
      'A find function would be transformative.',
    ],
  },
  {
    id: 'duplicate-notifications',
    kind: 'bug',
    route: '/settings/notifications',
    shape: 'fading',
    volume: 15,
    enterpriseBias: 0.3,
    phrasings: [
      'I am getting two notifications for every approval request.',
      'Everything arrives twice.',
      'Duplicate emails for a single event, every time.',
      'My inbox has doubled and I have changed nothing.',
      'Each alert fires two or three times.',
    ],
  },
  {
    id: 'login-loop',
    kind: 'bug',
    route: '/login',
    shape: 'regression',
    volume: 21,
    enterpriseBias: 0.4,
    brokenIn: '4.11.0',
    phrasings: [
      'Reset my password and now I cannot get past the login screen.',
      'It keeps bouncing me back to sign in over and over.',
      'Stuck in an endless authentication loop this morning.',
      'I log in successfully and it immediately asks me to log in again.',
      'Cannot get into my account at all since yesterday.',
      'Sign in accepts my details then does nothing.',
    ],
  },
  {
    id: 'mobile-keyboard-overlap',
    kind: 'bug',
    route: '/mobile/entry',
    shape: 'steady',
    volume: 11,
    enterpriseBias: 0.15,
    phrasings: [
      'The keyboard hides the amount field on my SE.',
      'Cannot see what I am typing on a small screen.',
      'The input I need is behind the on-screen keys.',
      'On mobile the form is covered up as soon as I tap it.',
    ],
  },
  {
    id: 'api-rate-limits',
    kind: 'question',
    route: '/settings/api',
    shape: 'trickle',
    volume: 8,
    enterpriseBias: 0.7,
    phrasings: [
      'What are the rate limits on the public API?',
      'How many requests per minute are we allowed?',
      'Is there documentation on throttling behaviour anywhere?',
      'We keep getting 429s and cannot find the published ceiling.',
    ],
  },
  {
    id: 'custom-categories',
    kind: 'feature_request',
    route: '/settings',
    shape: 'steady',
    volume: 17,
    enterpriseBias: 0.4,
    phrasings: [
      'Let admins edit the category dropdown.',
      'We need our own labels, not the built-in ones.',
      'The fixed taxonomy does not match how our business works.',
      'Please make the classification list configurable.',
      'Custom fields would let us stop keeping a parallel spreadsheet.',
    ],
  },
  {
    id: 'offline-mode',
    kind: 'feature_request',
    route: '/mobile/entry',
    shape: 'trickle',
    volume: 10,
    enterpriseBias: 0.25,
    phrasings: [
      'I need to add entries on a plane with no wifi.',
      'Does this work without a connection?',
      'Everything is lost if I lose signal halfway through.',
      'Offline support would help enormously for field staff.',
    ],
  },
  {
    id: 'audit-log',
    kind: 'feature_request',
    route: '/settings/security',
    shape: 'trickle',
    volume: 7,
    enterpriseBias: 0.85,
    phrasings: [
      'Would be great to have an audit log for compliance.',
      'We need to show our auditors who changed what and when.',
      'Is there any record of administrative actions?',
      'SOC 2 requires we can produce an activity trail.',
    ],
  },
  {
    id: 'multi-currency',
    kind: 'feature_request',
    route: '/settings',
    shape: 'growing',
    volume: 20,
    enterpriseBias: 0.6,
    phrasings: [
      'Support for local currencies when travelling would be huge.',
      'multi currency please',
      'Everything is forced into dollars and our team is in three countries.',
      'We operate in euros and have to convert by hand every month.',
      'Foreign exchange handling is completely missing.',
    ],
  },
  {
    id: 'onboarding-confusing',
    kind: 'question',
    route: '/onboarding',
    shape: 'fading',
    volume: 13,
    enterpriseBias: 0.2,
    phrasings: [
      'I have signed up and I genuinely do not know what to do next.',
      'The first-run experience left me staring at an empty screen.',
      'Where do I even start?',
      'Nothing explained what this wanted from me.',
      'Took me half an hour to work out the basic flow.',
    ],
  },
  {
    id: 'praise-support',
    kind: 'praise',
    route: '/dashboard',
    shape: 'steady',
    volume: 12,
    enterpriseBias: 0.4,
    phrasings: [
      'Your support team is genuinely excellent, thank you.',
      'Fastest response I have had from any vendor. Appreciated.',
      'Whoever handled my ticket yesterday deserves a raise.',
      'Really happy with how quickly that got sorted.',
    ],
  },
  {
    id: 'chart-colours-inaccessible',
    kind: 'bug',
    route: '/dashboard',
    shape: 'trickle',
    volume: 6,
    enterpriseBias: 0.3,
    phrasings: [
      'I am colourblind and cannot tell two of the chart series apart.',
      'The red and green lines are identical to me.',
      'Please do not rely on colour alone to distinguish data.',
    ],
  },
  {
    id: 'webhook-retries',
    kind: 'bug',
    route: '/settings/api',
    shape: 'trickle',
    volume: 8,
    enterpriseBias: 0.75,
    phrasings: [
      'Webhooks are not retried when our endpoint is briefly down.',
      'We lost a day of events during a short outage on our side.',
      'A failed delivery seems to just be dropped permanently.',
      'Is there a dead letter queue for undelivered callbacks?',
    ],
  },
  {
    id: 'session-timeout-short',
    kind: 'bug',
    route: '/login',
    shape: 'steady',
    volume: 13,
    enterpriseBias: 0.5,
    phrasings: [
      'I get logged out constantly, several times a day.',
      'The session expires while I am still actively using it.',
      'Being kicked out mid-task and losing work is infuriating.',
      'Why do I have to sign in again every hour?',
    ],
  },
  {
    id: 'attachment-size-limit',
    kind: 'bug',
    route: '/mobile/capture',
    shape: 'trickle',
    volume: 7,
    enterpriseBias: 0.25,
    phrasings: [
      'Anything over 5MB is rejected with no useful message.',
      'My photo will not upload and it does not say why.',
      'The file size cap is far too small for a modern camera.',
    ],
  },
  {
    id: 'ocr-accuracy',
    kind: 'bug',
    route: '/mobile/capture',
    shape: 'steady',
    volume: 16,
    enterpriseBias: 0.3,
    phrasings: [
      'The text recognition gets the date wrong on faded paper.',
      'It reads the total as the wrong number about a third of the time.',
      'Character recognition is unreliable enough that I check every one.',
      'Automatic extraction gets confused by anything crumpled.',
      'I end up correcting the scanned values manually anyway.',
    ],
  },
];

/** Releases in the window, oldest first. */
export const RELEASES: { version: string; day: number }[] = [
  { version: '4.10.0', day: 0 },
  { version: '4.11.0', day: 28 },
  { version: '4.11.2', day: 44 },
  { version: '4.12.0', day: 71 },
  { version: '4.12.1', day: 84 },
  { version: '4.13.0', day: 104 },
];
