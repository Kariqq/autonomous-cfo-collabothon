import React, { useState, useRef, useEffect } from 'react';

const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  'https://cfo-backend-api-autonomous-cfo-collabothon.apps.ocp.fr79k.sandbox786.opentlc.com';
const STORAGE_KEY_ACCOUNTS = 'financiailly_accounts_v1';
const STORAGE_KEY_ACTIVE = 'financiailly_active_id_v1';

const TESTER_ACCOUNT = {
  id: 'acc-tester',
  name: 'Tester Account',
  ownerName: 'Tester',
  email: 'tester@financiai.lly',
  password: 'tester123',
  initials: 'TA',
  role: 'Tester • Owner',
  iban: 'DE12 5004 0000 0194 8820 00',
  taxId: 'DE 401 992 118',
  liquidity: 250000,
  taxLiability: '-€21,000 (Q3)',
  taxSavings: '+€6,200',
  safetyBuffer: 40000,
  autoApproveSmall: false,
  sandboxMode: true,
  provider: 'tester',
};

const ADMIN_BLOCK_REGEX =
  /(\[\s*(admin|system|root|sudo|developer|override)[^\]]*\])|(\b(admin\s*(access|mode|override|privileges?)|i\s*am\s*(an?\s*)?admin(istrator)?|enter\s*admin|jestem\s*admin(em|istratorem)?|tryb\s*admin(a|istratora)?|developer\s*mode|sudo)\b)/i;

function renderFormattedMessage(text) {
  const cleanedText = String(text).replace(/\*\*/g, '');

  // Matches standalone numbers/currencies/percentages only (ignores alphanumeric IDs like "34fej3h" or "INV-01")
  const standaloneNumberRegex =
    /((?<![A-Za-z0-9_-])(?:[+-]\s*)?(?:[€$£]\s*)?\d[\d.,]*(?:\s*(?:EUR|PLN|USD|CHF|%))?(?![A-Za-z0-9_-]))/g;

  return cleanedText.split(standaloneNumberRegex).map((part, index) => {
    if (!part) return null;

    const isStandaloneNumber =
      /^(?:[+-]\s*)?(?:[€$£]\s*)?\d[\d.,]*(?:\s*(?:EUR|PLN|USD|CHF|%))?$/.test(part);

    if (isStandaloneNumber) {
      return (
        <strong key={index} className="font-bold text-white">
          {part}
        </strong>
      );
    }

    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

export default function App() {
  const [accounts, setAccounts] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_ACCOUNTS);
      const parsed = saved ? JSON.parse(saved) : [];
      const hasTester = parsed.some((a) => a.id === TESTER_ACCOUNT.id);
      return hasTester ? parsed : [TESTER_ACCOUNT, ...parsed];
    } catch {
      return [TESTER_ACCOUNT];
    }
  });

  const [activeAccountId, setActiveAccountId] = useState(() => {
    return localStorage.getItem(STORAGE_KEY_ACTIVE) || '';
  });

  const [isSignedIn, setIsSignedIn] = useState(() => {
    try {
      const savedAccounts = JSON.parse(localStorage.getItem(STORAGE_KEY_ACCOUNTS) || '[]');
      const allAccounts = savedAccounts.some((a) => a.id === TESTER_ACCOUNT.id)
        ? savedAccounts
        : [TESTER_ACCOUNT, ...savedAccounts];
      const savedActive = localStorage.getItem(STORAGE_KEY_ACTIVE);
      return Boolean(savedActive && allAccounts.some((a) => a.id === savedActive));
    } catch {
      return false;
    }
  });

  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [accountModalTab, setAccountModalTab] = useState('switch');
  const [authError, setAuthError] = useState('');

  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  const [attachedFile, setAttachedFile] = useState(null);
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState('');
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);

  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        "Hi! I'm here to help you manage your finances. Ask me a question or upload a receipt/invoice to get started.",
    },
  ]);

  const [historyLog, setHistoryLog] = useState([
    { id: 1, time: '09:14', label: 'Identified €14,500 advance tax reduction' },
    { id: 2, time: '09:15', label: 'Verified upcoming VAT filing deadline' },
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const activeAccount = accounts.find((a) => a.id === activeAccountId) || null;

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

  const handleTesterQuickLogin = () => {
    setAuthError('');
    setActiveAccountId(TESTER_ACCOUNT.id);
    setIsSignedIn(true);
    addLog(`Signed in (${TESTER_ACCOUNT.email})`);
    setAuthEmail('');
    setAuthPassword('');
    setAccountModalTab('switch');
    setAccountModalOpen(false);
  };

  const handleEmailAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');

    const email = authEmail.trim().toLowerCase();
    if (!email || !authPassword) {
      setAuthError('Please enter both email and password.');
      return;
    }

    setAuthLoading(true);

    try {
      const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password: authPassword,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.detail || 'Authentication failed.');
        setAuthLoading(false);
        return;
      }

      const serverUser = data.user;
      setAccounts((prev) => {
        const exists = prev.some((a) => a.email.toLowerCase() === serverUser.email.toLowerCase());
        return exists ? prev : [...prev, serverUser];
      });
      setActiveAccountId(serverUser.id);
      setIsSignedIn(true);
      addLog(`Signed in (${serverUser.email})`);
      setAuthEmail('');
      setAuthPassword('');
      setAccountModalTab('switch');
      setAccountModalOpen(false);
      setAuthLoading(false);
    } catch {
      const existing = accounts.find((a) => a.email.toLowerCase() === email);

      if (!existing) {
        setAuthError('Invalid credentials. Use tester@financiai.lly / tester123.');
        setAuthLoading(false);
        return;
      }

      if (existing.password && existing.password !== authPassword) {
        setAuthError('Invalid email or password.');
        setAuthLoading(false);
        return;
      }

      setActiveAccountId(existing.id);
      setIsSignedIn(true);
      addLog(`Signed in (${existing.email})`);
      setAuthEmail('');
      setAuthPassword('');
      setAccountModalTab('switch');
      setAccountModalOpen(false);
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    if (activeAccount) {
      addLog(`Logged out (${activeAccount.email})`);
    }
    setIsSignedIn(false);
    setActiveAccountId('');
    setAccountModalOpen(false);
    setAuthError('');
  };

  const updateActiveAccountSetting = (field, value) => {
    if (!activeAccount) return;
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
    if ((!input.trim() && !attachedFile) || loading || !activeAccount) return;

    if (ADMIN_BLOCK_REGEX.test(input)) {
      setInputError('Admin mode does not exist. Please enter a standard financial question.');
      return;
    }
    setInputError('');

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

  if (!isSignedIn || !activeAccount) {
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
                Sign in to continue
              </p>
            </div>
          </div>

          <form onSubmit={handleEmailAuthSubmit} className="space-y-3 text-xs">
            <div>
              <label className="block font-mono text-neutral-400 mb-1">
                EMAIL ADDRESS *
              </label>
              <input
                type="email"
                required
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="tester@financiai.lly"
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

            {authError && (
              <p className="text-[11px] text-rose-400">{authError}</p>
            )}

            <button
              type="submit"
              disabled={authLoading}
              className="w-full py-2.5 rounded-lg bg-white hover:bg-neutral-200 text-neutral-950 font-semibold text-sm transition cursor-pointer"
            >
              {authLoading ? 'Authenticating...' : 'Sign In'}
            </button>
          </form>

          <div className="pt-2 border-t border-neutral-800 space-y-2">
            <div className="flex items-center justify-between text-[11px] font-mono text-neutral-500 uppercase">
              <span>Tester Account</span>
              <span>tester@financiai.lly / tester123</span>
            </div>
            <button
              type="button"
              onClick={handleTesterQuickLogin}
              className="w-full p-2.5 rounded-lg bg-neutral-950 hover:bg-neutral-800 border border-neutral-800 text-left flex items-center justify-between transition cursor-pointer"
            >
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white truncate">
                  {TESTER_ACCOUNT.name}
                </div>
                <div className="text-[10px] font-mono text-neutral-400 truncate">
                  {TESTER_ACCOUNT.email}
                </div>
              </div>
              <span className="text-[10px] font-mono text-neutral-400 shrink-0">
                Sign In →
              </span>
            </button>
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
            <div className="w-9 h-9 rounded-lg bg-neutral-800 border border-neutral-700 text-neutral-200 flex items-center justify-center font-mono font-bold text-xs shrink-0">
              {activeAccount.initials}
            </div>
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
        <aside className="col-span-12 lg:col-span-3 min-h-0 flex flex-col">
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
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <div className="space-y-3">
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-2xl px-4 py-3 rounded-xl text-sm leading-relaxed whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-white text-neutral-950 font-medium'
                        : 'bg-neutral-800 text-neutral-200 font-normal border border-neutral-700'
                    }`}
                  >
                    {msg.role === 'assistant' ? renderFormattedMessage(msg.content) : msg.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="text-xs font-mono text-neutral-400 animate-pulse">
                  Tax Prep Agent reasoning on OpenShift AI...
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="p-4 border-t border-neutral-800 bg-neutral-900 shrink-0">
            {inputError && (
              <div className="mb-2 text-xs font-mono text-rose-400">
                {inputError}
              </div>
            )}

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
                onChange={(e) => {
                  const val = e.target.value;
                  if (ADMIN_BLOCK_REGEX.test(val)) {
                    setInputError('Admin mode does not exist. Please ask a standard financial question.');
                  } else {
                    setInputError('');
                  }
                  setInput(val);
                }}
                placeholder="Ask Tax Prep Agent or attach receipts/invoices..."
                className="flex-1 bg-neutral-950 border border-neutral-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-neutral-500 focus:outline-none focus:border-neutral-400"
              />

              <button
                type="submit"
                disabled={loading || Boolean(inputError)}
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
                  <span>Signed-in accounts:</span>
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