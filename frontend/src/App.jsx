import React, { useState, useRef, useEffect } from 'react';
import { GoogleLogin } from '@react-oauth/google';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const STORAGE_KEY_ACCOUNTS = 'financiailly_accounts_v1';
const STORAGE_KEY_ACTIVE = 'financiailly_active_id_v1';

const INITIAL_ACCOUNTS = [
  {
    id: 'acc-1',
    name: 'Anna Müller',
    ownerName: 'Anna Müller',
    email: 'anna.mueller@gmail.com',
    picture: '',
    initials: 'AM',
    role: 'SME Account • Owner',
    iban: 'DE89 3704 0044 0532 0130 00',
    taxId: 'DE 294 810 442',
    liquidity: 342500,
    taxLiability: '-€38,400 (Q3)',
    taxSavings: '+€14,500',
    safetyBuffer: 50000,
    autoApproveSmall: false,
    sandboxMode: true,
    provider: 'google',
  },
  {
    id: 'acc-2',
    name: 'Lukas Weber',
    ownerName: 'Lukas Weber',
    email: 'lukas.weber@gmail.com',
    picture: '',
    initials: 'LW',
    role: 'Corporate Account • CFO',
    iban: 'DE44 5004 0000 0891 2240 11',
    taxId: 'DE 812 553 901',
    liquidity: 890000,
    taxLiability: '-€94,200 (Q3)',
    taxSavings: '+€26,800',
    safetyBuffer: 150000,
    autoApproveSmall: true,
    sandboxMode: true,
    provider: 'google',
  },
];

const TAX_PROPOSAL = {
  id: 'tax-01',
  title: 'Q3 Advance Corporate Tax Adjustment Opportunity',
  autonomousAnalysis:
    'Current Q3 operating profit is 11% below projection due to one-off equipment maintenance and deductible energy costs.',
  recommendation:
    'Submit advance corporate tax prepayment reduction request (-€14,500) before the 10th of next month.',
  whyItMakesSense:
    'Prevents overpaying tax installments now, keeping €14,500 liquid in your operating account until annual tax reconciliation.',
  governance: 'REQUIRES USER APPROVAL',
};

function decodeGoogleJwt(token) {
  const base64Url = token.split('.')[1];
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const jsonPayload = decodeURIComponent(
    atob(base64)
      .split('')
      .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
      .join('')
  );
  return JSON.parse(jsonPayload);
}

export default function App() {
  const [accounts, setAccounts] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_ACCOUNTS);
      return saved ? JSON.parse(saved) : INITIAL_ACCOUNTS;
    } catch {
      return INITIAL_ACCOUNTS;
    }
  });

  const [activeAccountId, setActiveAccountId] = useState(() => {
    return localStorage.getItem(STORAGE_KEY_ACTIVE) || INITIAL_ACCOUNTS[0].id;
  });

  const [isSignedIn, setIsSignedIn] = useState(() => {
    return Boolean(localStorage.getItem(STORAGE_KEY_ACTIVE));
  });

  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [accountModalTab, setAccountModalTab] = useState('switch');
  const [authError, setAuthError] = useState('');

  const [authMode, setAuthMode] = useState('signin');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authDisplayName, setAuthDisplayName] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  const [decision, setDecision] = useState('pending');
  const [attachedFile, setAttachedFile] = useState(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef(null);

  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        'Tax Prep Agent active. I monitor your transactions to coordinate advance tax payments and identify deductible optimization opportunities. Review the recommendation above, upload receipts/invoices, or ask a tax question.',
    },
  ]);

  const [historyLog, setHistoryLog] = useState([
    { id: 1, time: '09:12', label: 'Signed in via Google (anna.mueller@gmail.com)' },
    { id: 2, time: '09:14', label: 'Identified €14,500 advance tax reduction' },
    { id: 3, time: '09:15', label: 'Verified upcoming VAT filing deadline' },
  ]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_ACCOUNTS, JSON.stringify(accounts));
  }, [accounts]);

  useEffect(() => {
    if (isSignedIn && activeAccountId) {
      localStorage.setItem(STORAGE_KEY_ACTIVE, activeAccountId);
    } else {
      localStorage.removeItem(STORAGE_KEY_ACTIVE);
    }
  }, [isSignedIn, activeAccountId]);

  const activeAccount = accounts.find((a) => a.id === activeAccountId) || accounts[0];

  const formatEuro = (val) =>
    new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: 0,
    }).format(val);

  const getLiquidityColor = (balance, buffer) => {
    if (balance < 0) return 'text-rose-400';
    if (balance < buffer) return 'text-amber-400';
    return 'text-emerald-400';
  };

  const getSignedMetricColor = (text) => {
    const trimmed = String(text).trim();
    if (trimmed.startsWith('-')) return 'text-rose-400';
    if (trimmed.startsWith('+')) return 'text-emerald-400';
    return 'text-neutral-100';
  };

  const addLog = (label) => {
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setHistoryLog((prev) => [{ id: Date.now(), time: now, label }, ...prev]);
  };

  const handleDecision = (choice) => {
    if (decision !== 'pending') return;
    setDecision(choice);

    const statusText =
      choice === 'approved'
        ? `Approved Tax Prep action (${activeAccount.sandboxMode ? 'Simulated' : 'Executed'})`
        : 'Declined Tax Prep proposal';

    addLog(statusText);

    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content:
          choice === 'approved'
            ? `✓ Action approved for ${activeAccount.name}: "${TAX_PROPOSAL.recommendation}". Logged in Context & History.`
            : `Cancelled "${TAX_PROPOSAL.recommendation}". No tax filing changes were submitted.`,
      },
    ]);
  };

  const handleGoogleSuccess = (credentialResponse) => {
    try {
      setAuthError('');
      const profile = decodeGoogleJwt(credentialResponse.credential);
      const email = profile.email.toLowerCase();
      const fullName = profile.name || email.split('@')[0];
      const picture = profile.picture || '';

      const existing = accounts.find((a) => a.email.toLowerCase() === email);
      if (existing) {
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === existing.id
              ? { ...a, picture, ownerName: fullName, name: fullName, provider: 'google' }
              : a
          )
        );
        setActiveAccountId(existing.id);
        setIsSignedIn(true);
        addLog(`Signed in with Google (${email})`);
      } else {
        const initials = fullName
          .split(' ')
          .slice(0, 2)
          .map((w) => w[0]?.toUpperCase())
          .join('');

        const newAcc = {
          id: `acc-${Date.now()}`,
          name: fullName,
          ownerName: fullName,
          email,
          picture,
          initials: initials || 'GM',
          role: 'Google Account • Owner',
          iban: 'DE61 5004 0000 0412 9901 00',
          taxId: 'DE 319 774 205',
          liquidity: 215000,
          taxLiability: '-€19,800 (Q3)',
          taxSavings: '+€8,400',
          safetyBuffer: 40000,
          autoApproveSmall: false,
          sandboxMode: true,
          provider: 'google',
        };
        setAccounts((prev) => [...prev, newAcc]);
        setActiveAccountId(newAcc.id);
        setIsSignedIn(true);
        addLog(`Created account & signed in with Google (${email})`);
      }

      setAccountModalTab('switch');
      setAccountModalOpen(false);
    } catch {
      setAuthError('Could not verify Google account token. Check VITE_GOOGLE_CLIENT_ID in .env.');
    }
  };

  const handleEmailAuthSubmit = (e) => {
    e.preventDefault();
    if (!authEmail.trim() || !authPassword.trim()) return;

    const email = authEmail.trim().toLowerCase();
    setAuthLoading(true);

    setTimeout(() => {
      const existing = accounts.find((a) => a.email.toLowerCase() === email);
      if (existing && authMode === 'signin') {
        setActiveAccountId(existing.id);
        setIsSignedIn(true);
        addLog(`Signed in (${existing.email})`);
      } else {
        const localPart = email.split('@')[0] || 'User';
        const formattedOwner = localPart
          .split(/[._-]/)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ');
        const accountName = authDisplayName.trim() || formattedOwner;
        const initials = accountName
          .split(' ')
          .slice(0, 2)
          .map((w) => w[0]?.toUpperCase())
          .join('');

        const created = {
          id: `acc-${Date.now()}`,
          name: accountName,
          ownerName: formattedOwner,
          email,
          picture: '',
          initials: initials || 'AC',
          role: 'Account • Owner',
          iban: 'DE12 5004 0000 0194 8820 00',
          taxId: 'DE 401 992 118',
          liquidity: 250000,
          taxLiability: '-€21,000 (Q3)',
          taxSavings: '+€6,200',
          safetyBuffer: 40000,
          autoApproveSmall: false,
          sandboxMode: true,
          provider: 'email',
        };
        setAccounts((prev) => [...prev, created]);
        setActiveAccountId(created.id);
        setIsSignedIn(true);
        addLog(`Registered & signed in (${email})`);
      }

      setAuthLoading(false);
      setAuthEmail('');
      setAuthPassword('');
      setAuthDisplayName('');
      setAccountModalTab('switch');
      setAccountModalOpen(false);
    }, 300);
  };

  const handleLogout = () => {
    setIsSignedIn(false);
    setAccountModalOpen(false);
    setAccountModalTab('auth');
    setAuthMode('signin');
    addLog(`Logged out (${activeAccount.email})`);
  };

  const updateActiveAccountSetting = (field, value) => {
    setAccounts((prev) =>
      prev.map((acc) => (acc.id === activeAccount.id ? { ...acc, [field]: value } : acc))
    );
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) setAttachedFile(file);
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if ((!input.trim() && !attachedFile) || loading) return;

    const userText = input.trim() || `Analyze tax document: ${attachedFile.name}`;
    const fileNote = attachedFile ? ` [Attached: ${attachedFile.name}]` : '';
    const currentFile = attachedFile;

    setMessages((prev) => [...prev, { role: 'user', content: `${userText}${fileNote}` }]);

    if (currentFile) {
      addLog(`Uploaded ${currentFile.name} (${activeAccount.name})`);
    }

    setInput('');
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setLoading(true);

    try {
      const formData = new FormData();
      formData.append('agent', 'tax');
      formData.append('account', activeAccount.name);
      formData.append('prompt', userText);
      if (currentFile) formData.append('file', currentFile);

      const res = await fetch(`${API_BASE_URL}/api/cfo/chat`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error('Backend not connected');
      const data = await res.json();

      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
    } catch {
      const fallback = currentFile
        ? `Scanned "${currentFile.name}" for ${activeAccount.name}. Categorized deductible business expenses and verified VAT alignment—your net tax reduction remains ${activeAccount.taxSavings}.`
        : `[Tax Prep Agent • RHOAI]: For ${activeAccount.name} (Tax ID ${activeAccount.taxId}), adjusting your Q3 advance prepayment retains ${activeAccount.taxSavings} in cash while keeping your ${formatEuro(activeAccount.safetyBuffer)} liquidity buffer intact.`;

      setMessages((prev) => [...prev, { role: 'assistant', content: fallback }]);
    } finally {
      setLoading(false);
    }
  };

  if (!isSignedIn) {
    return (
      <div className="min-h-screen w-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-4 font-sans">
        <div className="w-full max-w-md rounded-2xl bg-neutral-900 border border-neutral-800 p-7 space-y-6 shadow-2xl">
          <div className="flex flex-col items-center text-center gap-3">
            <img
              src="/logo.png"
              alt="FinancAI.lly logo"
              className="h-14 w-auto object-contain"
            />
            <div>
              <h1 className="font-mono text-2xl tracking-tight text-white font-semibold">
                Financ<span className="text-neutral-400">AI</span>.lly
              </h1>
              <p className="text-xs text-neutral-400 mt-1">
                Sign in or create an account to continue
              </p>
            </div>
          </div>

          <div className="flex flex-col items-center justify-center p-4 rounded-xl bg-neutral-950 border border-neutral-800 space-y-2.5">
            <div className="text-[11px] font-mono text-neutral-400">
              CONTINUE WITH GOOGLE
            </div>
            <GoogleLogin
              theme="filled_black"
              size="large"
              shape="rectangular"
              text="continue_with"
              onSuccess={handleGoogleSuccess}
              onError={() =>
                setAuthError(
                  'Google Sign-In failed. Check VITE_GOOGLE_CLIENT_ID and Test users in Google Cloud.'
                )
              }
            />
            {authError && (
              <p className="text-[11px] text-rose-400 text-center">{authError}</p>
            )}
          </div>

          <div className="relative flex items-center">
            <div className="flex-grow border-t border-neutral-800" />
            <span className="shrink mx-3 text-[11px] font-mono text-neutral-500">
              OR WITH EMAIL
            </span>
            <div className="flex-grow border-t border-neutral-800" />
          </div>

          <form onSubmit={handleEmailAuthSubmit} className="space-y-3 text-xs">
            <div className="flex gap-2 p-1 rounded-lg bg-neutral-950 border border-neutral-800 font-mono">
              <button
                type="button"
                onClick={() => setAuthMode('signin')}
                className={`flex-1 py-1.5 rounded-md transition ${
                  authMode === 'signin'
                    ? 'bg-neutral-800 text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => setAuthMode('signup')}
                className={`flex-1 py-1.5 rounded-md transition ${
                  authMode === 'signup'
                    ? 'bg-neutral-800 text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Create Account
              </button>
            </div>

            {authMode === 'signup' && (
              <div>
                <label className="block font-mono text-neutral-400 mb-1">
                  FULL NAME
                </label>
                <input
                  type="text"
                  value={authDisplayName}
                  onChange={(e) => setAuthDisplayName(e.target.value)}
                  placeholder="Your name"
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white"
                />
              </div>
            )}

            <div>
              <label className="block font-mono text-neutral-400 mb-1">
                EMAIL ADDRESS *
              </label>
              <input
                type="email"
                required
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="name@gmail.com"
                className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white"
              />
            </div>

            <div>
              <label className="block font-mono text-neutral-400 mb-1">
                PASSWORD *
              </label>
              <input
                type="password"
                required
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white"
              />
            </div>

            <button
              type="submit"
              disabled={authLoading}
              className="w-full py-2.5 rounded-lg bg-white hover:bg-neutral-200 text-neutral-950 font-semibold text-sm transition cursor-pointer"
            >
              {authLoading
                ? 'Authenticating...'
                : authMode === 'signin'
                ? 'Sign In'
                : 'Create Account'}
            </button>
          </form>

          <div className="pt-2 border-t border-neutral-800 space-y-2">
            <div className="text-[11px] font-mono text-neutral-500 uppercase">
              Quick Demo Accounts
            </div>
            <div className="grid grid-cols-2 gap-2">
              {accounts.slice(0, 2).map((acc) => (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => {
                    setActiveAccountId(acc.id);
                    setIsSignedIn(true);
                    addLog(`Signed in to demo account (${acc.email})`);
                  }}
                  className="p-2.5 rounded-lg bg-neutral-950 hover:bg-neutral-800 border border-neutral-800 text-left transition cursor-pointer"
                >
                  <div className="text-xs font-semibold text-white truncate">
                    {acc.name}
                  </div>
                  <div className="text-[10px] font-mono text-neutral-400 truncate">
                    {acc.email}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100 flex flex-col p-3 gap-3 font-sans">
      <div className="grid grid-cols-12 gap-3 shrink-0">
        <header className="col-span-12 lg:col-span-9 rounded-xl bg-neutral-900 border border-neutral-800 px-5 py-2.5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <img
              src="/logo.png"
              alt="FinancAI.lly logo"
              className="h-10 w-auto object-contain shrink-0"
            />
            <span className="font-mono text-xl leading-none tracking-tight text-white font-semibold">
              Financ<span className="text-neutral-400">AI</span>.lly
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div>
              <div className="text-[11px] text-neutral-500 uppercase tracking-wider">
                Current Liquidity
              </div>
              <div
                className={`text-base font-semibold ${getLiquidityColor(
                  activeAccount.liquidity,
                  activeAccount.safetyBuffer
                )}`}
              >
                {activeAccount.liquidity > 0
                  ? `+${formatEuro(activeAccount.liquidity)}`
                  : formatEuro(activeAccount.liquidity)}
              </div>
            </div>
            <div className="h-7 w-px bg-neutral-800 hidden sm:block" />
            <div>
              <div className="text-[11px] text-neutral-500 uppercase tracking-wider">
                Est. Tax Liability
              </div>
              <div
                className={`text-base font-semibold ${getSignedMetricColor(
                  activeAccount.taxLiability
                )}`}
              >
                {activeAccount.taxLiability}
              </div>
            </div>
            <div className="h-7 w-px bg-neutral-800 hidden sm:block" />
            <div>
              <div className="text-[11px] text-neutral-500 uppercase tracking-wider">
                Tax Savings Found
              </div>
              <div
                className={`text-base font-semibold ${getSignedMetricColor(
                  activeAccount.taxSavings
                )}`}
              >
                {activeAccount.taxSavings}
              </div>
            </div>
            <div className="h-7 w-px bg-neutral-800 hidden sm:block" />
            <div>
              <div className="text-[11px] text-neutral-500 uppercase tracking-wider">
                Governance
              </div>
              <div className="text-xs font-mono text-neutral-200 mt-0.5">
                {activeAccount.sandboxMode ? 'SANDBOX • APPROVAL' : 'LIVE • APPROVAL'}
              </div>
            </div>
          </div>
        </header>

        <div className="col-span-12 lg:col-span-3 rounded-xl bg-neutral-900 border border-neutral-800 px-4 py-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setAccountModalTab('switch');
              setAuthError('');
              setAccountModalOpen(true);
            }}
            className="flex items-center gap-3 min-w-0 text-left hover:opacity-90 transition cursor-pointer flex-1"
          >
            {activeAccount.picture ? (
              <img
                src={activeAccount.picture}
                alt={activeAccount.ownerName}
                className="w-9 h-9 rounded-lg object-cover border border-neutral-700 shrink-0"
              />
            ) : (
              <div className="w-9 h-9 rounded-lg bg-neutral-800 border border-neutral-700 text-neutral-200 flex items-center justify-center font-mono font-bold text-xs shrink-0">
                {activeAccount.initials}
              </div>
            )}
            <div className="truncate">
              <div className="text-sm font-semibold text-white truncate">
                {activeAccount.name}
              </div>
              <div className="text-[11px] text-neutral-400 truncate">
                {activeAccount.email}
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={handleLogout}
            className="text-[11px] font-mono px-2.5 py-1.5 rounded bg-neutral-800 hover:bg-rose-500/20 text-neutral-200 hover:text-rose-300 border border-neutral-700 hover:border-rose-500/40 shrink-0 transition cursor-pointer"
          >
            Log out
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-12 gap-3">
        <aside className="col-span-12 lg:col-span-3 min-h-0 flex flex-col gap-3">
          <div className="rounded-xl bg-neutral-900 border border-neutral-800 p-4 shrink-0">
            <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-500 mb-3">
              Active Agent
            </div>
            <div className="p-3 rounded-lg bg-neutral-800/90 border border-neutral-600 text-white flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0" />
                <div>
                  <div className="text-sm font-semibold leading-tight">Tax Prep</div>
                  <div className="text-[10px] text-neutral-400">
                    Advance Tax & Deduction Optimizer
                  </div>
                </div>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 font-semibold">
                Save €14.5k
              </span>
            </div>
          </div>

          <div className="flex-1 min-h-0 rounded-xl bg-neutral-900 border border-neutral-800 p-4 flex flex-col">
            <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-500 mb-2">
              Context & History
            </div>

            <div className="p-3 rounded-lg bg-neutral-950 border border-neutral-800 text-[11px] space-y-1 mb-3 shrink-0 font-mono">
              <div className="text-neutral-300 font-semibold">TAX CONTEXT:</div>
              <div className="text-neutral-400 truncate">• User: {activeAccount.email}</div>
              <div className="text-neutral-400 truncate">• Tax ID: {activeAccount.taxId}</div>
              <div className="text-neutral-400">
                • Safety Buffer: Min. {formatEuro(activeAccount.safetyBuffer)}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1 text-xs">
              {historyLog.map((item) => (
                <div
                  key={item.id}
                  className="p-2.5 rounded-lg bg-neutral-950 border border-neutral-800/80 flex items-start gap-2.5"
                >
                  <span className="text-[11px] font-mono text-neutral-500 shrink-0">
                    {item.time}
                  </span>
                  <span className="text-neutral-300 leading-snug">{item.label}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <main className="col-span-12 lg:col-span-9 min-h-0 rounded-xl bg-neutral-900 border border-neutral-800 flex flex-col overflow-hidden">
          <div className="px-5 py-3 border-b border-neutral-800 flex flex-wrap items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-base text-white">Tax Prep AI Agent</h2>
              <span className="text-xs text-neutral-400">
                — Advance Tax & Deduction Optimizer
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11px] font-mono">
              <span className="px-2.5 py-1 rounded bg-neutral-800 text-neutral-200 border border-neutral-700">
                {TAX_PROPOSAL.governance}
              </span>
              <span className="px-2.5 py-1 rounded bg-neutral-800 text-neutral-400 border border-neutral-700">
                {activeAccount.sandboxMode ? 'SIMULATED SANDBOX' : 'LIVE EXECUTION'}
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <div className="p-4 rounded-xl bg-neutral-950 border border-neutral-700 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-mono uppercase tracking-wider text-neutral-200 font-semibold">
                  Proactive Finding • {TAX_PROPOSAL.title}
                </span>
                {decision !== 'pending' && (
                  <span
                    className={`text-xs font-mono px-2.5 py-0.5 rounded border ${
                      decision === 'approved'
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 font-semibold'
                        : 'bg-rose-500/20 text-rose-300 border-rose-500/50 font-semibold'
                    }`}
                  >
                    {decision === 'approved' ? '✓ APPROVED' : '✕ DECLINED'}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-neutral-900 border border-neutral-800">
                  <div className="text-neutral-400 font-mono text-[11px] mb-1">
                    01 / AUTONOMOUS ANALYSIS
                  </div>
                  <p className="text-neutral-300 leading-relaxed">
                    {TAX_PROPOSAL.autonomousAnalysis}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-neutral-900 border border-neutral-800">
                  <div className="text-neutral-200 font-mono text-[11px] mb-1">
                    02 / PROPOSED ACTION
                  </div>
                  <p className="text-neutral-200 leading-relaxed">
                    {TAX_PROPOSAL.recommendation}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-neutral-900 border border-neutral-800">
                  <div className="text-neutral-400 font-mono text-[11px] mb-1">
                    03 / EXPLAINABLE LOGIC
                  </div>
                  <p className="text-neutral-300 leading-relaxed">
                    {TAX_PROPOSAL.whyItMakesSense}
                  </p>
                </div>
              </div>

              {decision === 'pending' && (
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    onClick={() => handleDecision('rejected')}
                    className="px-3.5 py-1.5 rounded-lg text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border border-neutral-700 transition"
                  >
                    Decline
                  </button>
                  <button
                    onClick={() => handleDecision('approved')}
                    className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-neutral-200 text-neutral-950 transition"
                  >
                    Approve & Simulate Action
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-3">
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-2xl px-4 py-3 rounded-xl text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-white text-neutral-950 font-medium'
                        : 'bg-neutral-800 text-neutral-100 border border-neutral-700'
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="text-xs font-mono text-neutral-400 animate-pulse">
                  Tax Prep Agent reasoning on OpenShift AI...
                </div>
              )}
            </div>
          </div>

          <div className="p-4 border-t border-neutral-800 bg-neutral-900 shrink-0">
            {attachedFile && (
              <div className="mb-2 inline-flex items-center gap-2 px-3 py-1 rounded bg-neutral-800 border border-neutral-700 text-xs font-mono text-neutral-200">
                <span>📎 {attachedFile.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setAttachedFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                  className="text-neutral-400 hover:text-white"
                >
                  ✕
                </button>
              </div>
            )}

            <form onSubmit={handleSend} className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.pdf,.xlsx,.json,.txt"
                onChange={handleFileChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Upload receipts, invoices, or tax CSV"
                className="px-3.5 py-2.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-xs font-mono text-neutral-200 transition shrink-0"
              >
                + File
              </button>

              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask Tax Prep Agent or attach receipts/invoices..."
                className="flex-1 bg-neutral-950 border border-neutral-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-neutral-400"
              />

              <button
                type="submit"
                disabled={loading}
                className="px-5 py-2.5 rounded-lg bg-white hover:bg-neutral-200 disabled:opacity-50 text-neutral-950 font-semibold text-sm transition shrink-0"
              >
                Send
              </button>
            </form>
          </div>
        </main>
      </div>

      {accountModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl bg-neutral-900 border border-neutral-700 overflow-hidden shadow-2xl">
            <div className="px-5 py-3.5 border-b border-neutral-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <img
                  src="/logo.png"
                  alt="FinancAI.lly logo"
                  className="w-8 h-8 object-contain"
                />
                <span className="font-mono text-sm text-white">
                  FinancAI.lly Account
                </span>
              </div>
              <button
                onClick={() => setAccountModalOpen(false)}
                className="text-neutral-400 hover:text-white text-sm font-mono"
              >
                [ESC / ✕]
              </button>
            </div>

            <div className="grid grid-cols-2 border-b border-neutral-800 text-xs font-mono">
              {[
                { id: 'switch', label: 'My Accounts' },
                { id: 'settings', label: 'Settings & Rules' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setAccountModalTab(tab.id)}
                  className={`py-3 text-center transition border-b-2 ${
                    accountModalTab === tab.id
                      ? 'border-white text-white bg-neutral-800/60'
                      : 'border-transparent text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {accountModalTab === 'switch' && (
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between text-xs text-neutral-400">
                  <span>Signed-in workspaces:</span>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="px-3 py-1 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/40 font-mono text-[11px] font-semibold transition cursor-pointer"
                  >
                    Log out
                  </button>
                </div>

                <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                  {accounts.map((acc) => {
                    const isCurrent = acc.id === activeAccount.id;
                    return (
                      <button
                        key={acc.id}
                        type="button"
                        onClick={() => {
                          setActiveAccountId(acc.id);
                          addLog(`Switched workspace to ${acc.name} (${acc.email})`);
                          setAccountModalOpen(false);
                        }}
                        className={`w-full p-3.5 rounded-lg border text-left flex items-center justify-between transition ${
                          isCurrent
                            ? 'bg-neutral-800 border-neutral-500 text-white'
                            : 'bg-neutral-950 border-neutral-800 text-neutral-300 hover:border-neutral-600'
                        }`}
                      >
                        <div>
                          <div className="text-sm font-semibold">{acc.name}</div>
                          <div className="text-[11px] font-mono text-neutral-400 mt-0.5">
                            {acc.email}
                          </div>
                        </div>
                        <div className="text-right">
                          <div
                            className={`text-sm font-mono font-semibold ${
                              acc.liquidity < 0 ? 'text-rose-400' : 'text-emerald-400'
                            }`}
                          >
                            {acc.liquidity > 0
                              ? `+${formatEuro(acc.liquidity)}`
                              : formatEuro(acc.liquidity)}
                          </div>
                          <div className="text-[10px] font-mono text-neutral-400">
                            {isCurrent ? 'ACTIVE' : 'SWITCH'}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {accountModalTab === 'settings' && (
              <div className="p-5 space-y-4 text-xs">
                <div className="p-3 rounded-lg bg-neutral-950 border border-neutral-800">
                  <div className="font-mono text-neutral-400">EDITING SETTINGS FOR:</div>
                  <div className="text-sm font-semibold text-white mt-0.5">
                    {activeAccount.name} ({activeAccount.email})
                  </div>
                </div>

                <div>
                  <label className="block font-mono text-neutral-400 mb-1">
                    MINIMUM CASH SAFETY BUFFER (€)
                  </label>
                  <input
                    type="number"
                    value={activeAccount.safetyBuffer}
                    onChange={(e) =>
                      updateActiveAccountSetting('safetyBuffer', Number(e.target.value) || 0)
                    }
                    className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-white"
                  />
                </div>

                <label className="flex items-center justify-between p-3 rounded-lg bg-neutral-950 border border-neutral-800 cursor-pointer">
                  <div>
                    <div className="text-sm font-medium text-white">
                      Sandbox Simulation Mode
                    </div>
                    <div className="text-[11px] text-neutral-400">
                      Simulate approved tax filings without live submission
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={activeAccount.sandboxMode}
                    onChange={(e) =>
                      updateActiveAccountSetting('sandboxMode', e.target.checked)
                    }
                    className="w-4 h-4 accent-white"
                  />
                </label>

                <label className="flex items-center justify-between p-3 rounded-lg bg-neutral-950 border border-neutral-800 cursor-pointer">
                  <div>
                    <div className="text-sm font-medium text-white">
                      Auto-Approve Low-Risk Actions (&lt; €500)
                    </div>
                    <div className="text-[11px] text-neutral-400">
                      Allow Tax Agent to categorize minor deductions automatically
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={activeAccount.autoApproveSmall}
                    onChange={(e) =>
                      updateActiveAccountSetting('autoApproveSmall', e.target.checked)
                    }
                    className="w-4 h-4 accent-white"
                  />
                </label>

                <div className="pt-1 flex justify-end">
                  <button
                    onClick={() => {
                      addLog(`Updated tax governance settings for ${activeAccount.name}`);
                      setAccountModalOpen(false);
                    }}
                    className="px-4 py-2 rounded-lg bg-white text-neutral-950 font-semibold hover:bg-neutral-200"
                  >
                    Save Settings
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}