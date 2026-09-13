/**
 * GROUP 00 — sign in, choosing a client, the Hub, and the firm-level screens
 * that are not part of any one engagement.
 */
export const SHOTS = [
  { id: '00-01-signin', page: 'index.html', title: 'Sign in', session: false,
    note: 'The first screen. Firm email and password; the Hub replaces it once signed in.' },

  { id: '00-02-choose-client', page: 'index.html', title: 'Choose your client engagement',
    session: { activeClient: undefined },
    note: 'A session works on ONE client at a time. This is where that is chosen, and the '
        + 'left rail carries it from then on. "All clients (administrator view)" is the '
        + 'firm-wide view; it is not the working mode.' },

  { id: '00-03-hub', page: 'index.html', title: 'The Hub', full: true,
    note: 'Where every session starts once a client is chosen. The tiles are numbered in the '
        + 'order the engagement runs; the left rail is the same list and is on every screen.' },

  { id: '00-90-account', page: 'account.html', title: 'Account and subscription', full: true,
    note: 'What the FIRM pays to use VYNE. Not client billing — that is a separate screen.' },

  { id: '00-91-billing', page: 'billing.html', title: 'Client billing and AI usage', full: true,
    note: 'Real AI cost by client, at cost, for pass-through to the client.' },

  { id: '00-92-admin', page: 'admin.html', title: 'Firm administration', full: true,
    note: 'Team members and their roles. A consultant can be scoped to named clients only.' },

  { id: '00-93-about', page: 'about.html', title: 'About and version', full: true,
    note: 'The running version. Worth knowing where this is when reporting anything.' },
];
