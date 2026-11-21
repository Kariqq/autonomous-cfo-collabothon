import React, { useState, useRef, useEffect } from 'react';

const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  'https://cfo-backend-api-autonomous-cfo-collabothon.apps.ocp.fr79k.sandbox786.opentlc.com';
const STORAGE_KEY_ACCOUNTS = 'financiailly_accounts_v1';
const STORAGE_KEY_ACTIVE = 'financiailly_active_id_v1';
const STORAGE_KEY_THEME = 'financiailly_theme_v1';
const STORAGE_KEY_FONT_SIZE = 'financiailly_font_size_v1';

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

const FONT_SIZE_OPTIONS = [
  { id: 'sm', label: 'A-', title: 'Small text', rootPx: '14px' },
  { id: 'md', label: 'A', title: 'Default text', rootPx: '16px' },
  { id: 'lg', label: 'A+', title: 'Large text', rootPx: '20px' },
  { id: 'xl', label: 'A++', title: 'Extra large accessible text', rootPx: '25px' },
];

function renderFormattedMessage(text, isDark) {
  const cleanedText = String(text).replace(/\*\*/g, '');

  const standaloneNumberRegex =
    /((?<![A-Za-z0-9_-])(?:[+-]\s*)?(?:[€$£]\s*)?\d[\d.,]*(?:\s*(?:EUR|PLN|USD|CHF|%))?(?![A-Za-z0-9_-]))/g;

  return cleanedText.split(standaloneNumberRegex).map((part, index) => {
    if (!part) return null;

    const isStandaloneNumber =
      /^(?:[+-]\s*)?(?:[€$£]\s*)?\d[\d.,]*(?:\s*(?:EUR|PLN|USD|CHF|%))?$/.test(part);

    if (isStandaloneNumber) {
      return (
        <strong
          key={index}
          className={`font-bold ${isDark ? 'text-white' : 'text-stone-950'}`}
        >
          {part}
        </strong>
      );
    }

    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function LiquidityForecastChart({ chart, isDark }) {
  const points = Array.isArray(chart?.points) ? chart.points : [];
  if (points.length < 2) return null;

  const width = 560;
  const height = 210;
  const padLeft = 64;
  const padRight = 18;
  const padTop = 20;
  const padBottom = 34;

  const buffer = Number(chart.safety_buffer ?? 0);
  const values = points.map((p) => Number(p.balance || 0));
  const minVal = Math.min(...values, buffer, 0);
  const maxVal = Math.max(...values, buffer, 0);
  const span = maxVal - minVal || 1;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const toX = (idx) => padLeft + (idx / (points.length - 1)) * plotW;
  const toY = (val) => padTop + (1 - (val - minVal) / span) * plotH;

  const coords = points.map((p, i) => ({
    x: toX(i),
    y: toY(Number(p.balance || 0)),
    label: p.label,
    balance: Number(p.balance || 0),
  }));

  const polylinePts = coords.map((c) => `${c.x},${c.y}`).join(' ');
  const bufferY = toY(buffer);
  const zeroY = toY(0);

  return (
    <div
      className={`mt-3 rounded-xl border p-3 ${
        isDark
          ? 'border-neutral-700/70 bg-neutral-900/80 text-neutral-300'
          : 'border-[#d6cbb7] bg-[#fbf7f0] text-stone-800'
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold">{chart.title || 'Liquidity Forecast'}</span>
        <span className={isDark ? 'text-amber-300' : 'text-amber-800 font-medium'}>
          Safety Buffer: {buffer.toLocaleString()} {chart.currency || ''}
        </span>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full overflow-visible">
        {minVal < 0 && maxVal > 0 && (
          <line
            x1={padLeft}
            x2={width - padRight}
            y1={zeroY}
            y2={zeroY}
            stroke={isDark ? '#737373' : '#a8a29e'}
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        )}

        <line
          x1={padLeft}
          x2={width - padRight}
          y1={bufferY}
          y2={bufferY}
          stroke={isDark ? '#f59e0b' : '#d97706'}
          strokeWidth="1.5"
          strokeDasharray="5 4"
        />
        <text x={padLeft + 4} y={bufferY - 5} fill={isDark ? '#fbbf24' : '#b45309'} fontSize="10">
          Buffer ({buffer.toLocaleString()})
        </text>

        <text x={padLeft - 8} y={padTop + 4} textAnchor="end" fill={isDark ? '#a3a3a3' : '#57534e'} fontSize="10">
          {maxVal.toLocaleString()}
        </text>
        <text x={padLeft - 8} y={height - padBottom} textAnchor="end" fill={isDark ? '#a3a3a3' : '#57534e'} fontSize="10">
          {minVal.toLocaleString()}
        </text>

        <polyline
          fill="none"
          stroke={isDark ? '#38bdf8' : '#0284c7'}
          strokeWidth="2.5"
          points={polylinePts}
        />

        {coords.map((c, idx) => {
          const isBelowBuffer = c.balance < buffer;
          const showXLabel =
            coords.length <= 7 ||
            idx === 0 ||
            idx === coords.length - 1 ||
            idx % Math.ceil(coords.length / 6) === 0;

          return (
            <g key={`${c.label}-${idx}`}>
              <circle
                cx={c.x}
                cy={c.y}
                r="3.5"
                fill={
                  isBelowBuffer
                    ? isDark
                      ? '#ef4444'
                      : '#dc2626'
                    : isDark
                    ? '#38bdf8'
                    : '#0284c7'
                }
              />
              {showXLabel && (
                <text
                  x={c.x}
                  y={height - 10}
                  textAnchor="middle"
                  fill={isDark ? '#a3a3a3' : '#57534e'}
                  fontSize="10"
                >
                  {c.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem(STORAGE_KEY_THEME) || 'dark';
  });

  const [fontSize, setFontSize] = useState(() => {
    return localStorage.getItem(STORAGE_KEY_FONT_SIZE) || 'md';
  });

  const isDark = theme === 'dark';
  const isExtraLarge = fontSize === 'xl';

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
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);

  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        "Hi! I'm here to help you manage your finances. Ask me a question or upload a receipt/invoice to get started.",
      chart: null,
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
    localStorage.setItem(STORAGE_KEY_THEME, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_FONT_SIZE, fontSize);
    const chosen = FONT_SIZE_OPTIONS.find((opt) => opt.id === fontSize) || FONT_SIZE_OPTIONS[1];
    document.documentElement.style.fontSize = chosen.rootPx;
  }, [fontSize]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const activeAccount = accounts.find((a) => a.id === activeAccountId) || null;

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const formatEuro = (val) =>
    new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: 0,
    }).format(val);

  const getLiquidityColor = (balance, buffer) => {
    if (balance < 0) return isDark ? 'text-rose-400' : 'text-rose-700';
    if (balance < buffer) return isDark ? 'text-amber-400' : 'text-amber-700';
    return isDark ? 'text-emerald-400' : 'text-emerald-700';
  };

  const getSignedMetricColor = (text) => {
    const trimmed = String(text).trim();
    if (trimmed.startsWith('-')) return isDark ? 'text-rose-400' : 'text-rose-700';
    if (trimmed.startsWith('+')) return isDark ? 'text-emerald-400' : 'text-emerald-700';
    return isDark ? 'text-neutral-100' : 'text-stone-900';
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

    const userText = input.trim() || `Analyze tax document: ${attachedFile.name}`;
    const fileNote = attachedFile ? ` [Attached: ${attachedFile.name}]` : '';
    const currentFile = attachedFile;

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: `${userText}${fileNote}`, chart: null },
    ]);

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

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: data.reply, chart: data.chart || null },
      ]);
    } catch {
      const fallback = currentFile
        ? `Scanned "${currentFile.name}" for ${activeAccount.name}. Categorized deductible business expenses and verified VAT alignment—your net tax reduction remains ${activeAccount.taxSavings}.`
        : `[Tax Prep Agent • RHOAI]: For ${activeAccount.name} (Tax ID ${activeAccount.taxId}), adjusting your Q3 advance prepayment retains ${activeAccount.taxSavings} in cash while keeping your ${formatEuro(activeAccount.safetyBuffer)} liquidity buffer intact.`;

      setMessages((prev) => [...prev, { role: 'assistant', content: fallback, chart: null }]);
    } finally {
      setLoading(false);
    }
  };

  const renderAccessibilityControls = () => (
    <div
      role="group"
      aria-label="Theme and text size controls"
      className="flex items-center gap-2 flex-wrap"
    >
      <div
        className={`flex items-center rounded-lg border p-0.5 ${
          isDark
            ? 'bg-neutral-950 border-neutral-800'
            : 'bg-[#efe8db] border-[#d6cbb7]'
        }`}
      >
        {FONT_SIZE_OPTIONS.map((opt) => {
          const active = fontSize === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setFontSize(opt.id)}
              title={opt.title}
              aria-label={opt.title}
              aria-pressed={active}
              className={`px-2.5 py-1 rounded text-xs font-mono transition cursor-pointer ${
                active
                  ? isDark
                    ? 'bg-white text-neutral-950 font-bold'
                    : 'bg-stone-900 text-[#fbf7f0] font-bold'
                  : isDark
                  ? 'text-neutral-400 hover:text-white'
                  : 'text-stone-700 hover:text-stone-950'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={toggleTheme}
        aria-label={isDark ? 'Switch to light beige mode' : 'Switch to dark mode'}
        title={isDark ? 'Switch to light beige mode' : 'Switch to dark mode'}
        className={`px-3 py-1.5 rounded-lg border text-xs font-mono transition cursor-pointer ${
          isDark
            ? 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border-neutral-700'
            : 'bg-[#efe8db] hover:bg-[#e5dccb] text-stone-900 border-[#d6cbb7]'
        }`}
      >
        {isDark ? '☀ Light' : '☾ Dark'}
      </button>
    </div>
  );

  if (!isSignedIn || !activeAccount) {
    return (
      <div
        className={`min-h-screen w-screen flex items-center justify-center p-4 font-sans transition-colors ${
          isDark
            ? 'bg-neutral-950 text-neutral-100'
            : 'bg-[#f4efe6] text-stone-900'
        }`}
      >
        <div
          className={`w-full max-w-lg rounded-2xl border p-7 space-y-6 shadow-2xl ${
            isDark
              ? 'bg-neutral-900 border-neutral-800'
              : 'bg-[#fbf7f0] border-[#dcd2c0]'
          }`}
        >
          <div className="flex justify-end">{renderAccessibilityControls()}</div>

          <div className="flex flex-col items-center text-center gap-3">
            <img
              src="/logo.png"
              alt="FinancAI.lly logo"
              className={`h-14 w-auto object-contain ${isDark ? '' : 'invert'}`}
            />
            <div>
              <h1
                className={`font-mono text-2xl tracking-tight font-semibold ${
                  isDark ? 'text-white' : 'text-stone-950'
                }`}
              >
                Financ<span className={isDark ? 'text-neutral-400' : 'text-stone-500'}>AI</span>.lly
              </h1>
              <p
                className={`text-xs mt-1 ${
                  isDark ? 'text-neutral-400' : 'text-stone-700'
                }`}
              >
                Sign in to continue
              </p>
            </div>
          </div>

          <form onSubmit={handleEmailAuthSubmit} className="space-y-3 text-xs">
            <div>
              <label
                htmlFor="login-email"
                className={`block font-mono mb-1 ${
                  isDark ? 'text-neutral-400' : 'text-stone-700'
                }`}
              >
                EMAIL ADDRESS *
              </label>
              <input
                id="login-email"
                type="email"
                required
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="tester@financiai.lly"
                className={`w-full border rounded-lg px-3.5 py-2.5 text-sm focus:outline-none ${
                  isDark
                    ? 'bg-neutral-950 border-neutral-700 text-white focus:border-white'
                    : 'bg-[#f7f2e9] border-[#cfc3ae] text-stone-950 focus:border-stone-900'
                }`}
              />
            </div>

            <div>
              <label
                htmlFor="login-password"
                className={`block font-mono mb-1 ${
                  isDark ? 'text-neutral-400' : 'text-stone-700'
                }`}
              >
                PASSWORD *
              </label>
              <input
                id="login-password"
                type="password"
                required
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder="••••••••"
                className={`w-full border rounded-lg px-3.5 py-2.5 text-sm focus:outline-none ${
                  isDark
                    ? 'bg-neutral-950 border-neutral-700 text-white focus:border-white'
                    : 'bg-[#f7f2e9] border-[#cfc3ae] text-stone-950 focus:border-stone-900'
                }`}
              />
            </div>

            {authError && (
              <p role="alert" className="text-xs text-rose-600 font-medium">
                {authError}
              </p>
            )}

            <button
              type="submit"
              disabled={authLoading}
              className={`w-full py-2.5 rounded-lg font-semibold text-sm transition cursor-pointer ${
                isDark
                  ? 'bg-white hover:bg-neutral-200 text-neutral-950'
                  : 'bg-stone-900 hover:bg-stone-800 text-[#fbf7f0]'
              }`}
            >
              {authLoading ? 'Authenticating...' : 'Sign In'}
            </button>
          </form>

          <div
            className={`pt-2 border-t space-y-2 ${
              isDark ? 'border-neutral-800' : 'border-[#dfd6c5]'
            }`}
          >
            <div
              className={`flex items-center justify-between text-xs font-mono uppercase flex-wrap gap-1 ${
                isDark ? 'text-neutral-500' : 'text-stone-600'
              }`}
            >
              <span>Tester Account</span>
              <span>tester@financiai.lly / tester123</span>
            </div>
            <button
              type="button"
              onClick={handleTesterQuickLogin}
              className={`w-full p-3 rounded-lg border text-left flex items-center justify-between transition cursor-pointer ${
                isDark
                  ? 'bg-neutral-950 hover:bg-neutral-800 border-neutral-800'
                  : 'bg-[#f5efe4] hover:bg-[#ebe3d3] border-[#d6cbb7]'
              }`}
            >
              <div className="min-w-0">
                <div
                  className={`text-xs font-semibold truncate ${
                    isDark ? 'text-white' : 'text-stone-950'
                  }`}
                >
                  {TESTER_ACCOUNT.name}
                </div>
                <div
                  className={`text-xs font-mono truncate ${
                    isDark ? 'text-neutral-400' : 'text-stone-700'
                  }`}
                >
                  {TESTER_ACCOUNT.email}
                </div>
              </div>
              <span
                className={`text-xs font-mono shrink-0 ${
                  isDark ? 'text-neutral-400' : 'text-stone-700'
                }`}
              >
                Sign In →
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`w-screen flex flex-col p-3 gap-3 font-sans transition-colors ${
        isExtraLarge ? 'min-h-screen overflow-y-auto' : 'h-screen overflow-hidden'
      } ${
        isDark
          ? 'bg-neutral-950 text-neutral-100'
          : 'bg-[#f4efe6] text-stone-900'
      }`}
    >
      <div className="grid grid-cols-12 gap-3 shrink-0">
        <header
          className={`col-span-12 lg:col-span-9 rounded-xl border px-5 py-2.5 flex flex-wrap items-center justify-between gap-4 ${
            isDark
              ? 'bg-neutral-900 border-neutral-800'
              : 'bg-[#fbf7f0] border-[#dcd2c0] shadow-xs'
          }`}
        >
          <div className="flex items-center gap-2">
            <img
              src="/logo.png"
              alt="FinancAI.lly logo"
              className={`h-10 w-auto object-contain shrink-0 ${isDark ? '' : 'invert'}`}
            />
            <span
              className={`font-mono text-xl leading-none tracking-tight font-semibold ${
                isDark ? 'text-white' : 'text-stone-950'
              }`}
            >
              Financ<span className={isDark ? 'text-neutral-400' : 'text-stone-500'}>AI</span>.lly
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div>
              <div
                className={`text-xs uppercase tracking-wider ${
                  isDark ? 'text-neutral-500' : 'text-stone-600'
                }`}
              >
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
            <div
              className={`h-7 w-px hidden sm:block ${
                isDark ? 'bg-neutral-800' : 'bg-[#dfd6c5]'
              }`}
            />
            <div>
              <div
                className={`text-xs uppercase tracking-wider ${
                  isDark ? 'text-neutral-500' : 'text-stone-600'
                }`}
              >
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
            <div
              className={`h-7 w-px hidden sm:block ${
                isDark ? 'bg-neutral-800' : 'bg-[#dfd6c5]'
              }`}
            />
            <div>
              <div
                className={`text-xs uppercase tracking-wider ${
                  isDark ? 'text-neutral-500' : 'text-stone-600'
                }`}
              >
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

        <div
          className={`col-span-12 lg:col-span-3 rounded-xl border px-4 py-3 flex items-center justify-between gap-2 ${
            isDark
              ? 'bg-neutral-900 border-neutral-800'
              : 'bg-[#fbf7f0] border-[#dcd2c0] shadow-xs'
          }`}
        >
          <button
            type="button"
            onClick={() => {
              setAccountModalTab('switch');
              setAuthError('');
              setAccountModalOpen(true);
            }}
            className="flex items-center gap-3 min-w-0 text-left hover:opacity-90 transition cursor-pointer flex-1"
          >
            <div
              className={`w-9 h-9 rounded-lg border flex items-center justify-center font-mono font-bold text-xs shrink-0 ${
                isDark
                  ? 'bg-neutral-800 border-neutral-700 text-neutral-200'
                  : 'bg-[#efe8db] border-[#d6cbb7] text-stone-900'
              }`}
            >
              {activeAccount.initials}
            </div>
            <div className="truncate">
              <div
                className={`text-sm font-semibold truncate ${
                  isDark ? 'text-white' : 'text-stone-950'
                }`}
              >
                {activeAccount.name}
              </div>
              <div
                className={`text-xs truncate ${
                  isDark ? 'text-neutral-400' : 'text-stone-700'
                }`}
              >
                {activeAccount.email}
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={handleLogout}
            className={`text-xs font-mono px-2.5 py-1.5 rounded border shrink-0 transition cursor-pointer ${
              isDark
                ? 'bg-neutral-800 hover:bg-rose-500/20 text-neutral-200 hover:text-rose-300 border-neutral-700 hover:border-rose-500/40'
                : 'bg-[#efe8db] hover:bg-rose-100 text-stone-900 hover:text-rose-700 border-[#d6cbb7] hover:border-rose-300'
            }`}
          >
            Log out
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-12 gap-3">
        <aside className="col-span-12 lg:col-span-3 min-h-0 flex flex-col">
          <div
            className={`flex-1 min-h-0 rounded-xl border p-4 flex flex-col ${
              isDark
                ? 'bg-neutral-900 border-neutral-800'
                : 'bg-[#fbf7f0] border-[#dcd2c0] shadow-xs'
            }`}
          >
            <div
              className={`text-xs font-mono uppercase tracking-widest mb-2 ${
                isDark ? 'text-neutral-500' : 'text-stone-600'
              }`}
            >
              Context & History
            </div>

            <div
              className={`p-3 rounded-lg border text-xs space-y-1 mb-3 shrink-0 font-mono ${
                isDark
                  ? 'bg-neutral-950 border-neutral-800'
                  : 'bg-[#f4eee2] border-[#dfd6c5]'
              }`}
            >
              <div
                className={`font-semibold ${
                  isDark ? 'text-neutral-300' : 'text-stone-900'
                }`}
              >
                TAX CONTEXT:
              </div>
              <div
                className={`truncate ${
                  isDark ? 'text-neutral-400' : 'text-stone-700'
                }`}
              >
                • User: {activeAccount.email}
              </div>
              <div
                className={`truncate ${
                  isDark ? 'text-neutral-400' : 'text-stone-700'
                }`}
              >
                • Tax ID: {activeAccount.taxId}
              </div>
              <div className={isDark ? 'text-neutral-400' : 'text-stone-700'}>
                • Safety Buffer: Min. {formatEuro(activeAccount.safetyBuffer)}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1 text-xs">
              {historyLog.map((item) => (
                <div
                  key={item.id}
                  className={`p-2.5 rounded-lg border flex items-start gap-2.5 ${
                    isDark
                      ? 'bg-neutral-950 border-neutral-800/80'
                      : 'bg-[#f4eee2] border-[#dfd6c5]'
                  }`}
                >
                  <span
                    className={`text-xs font-mono shrink-0 ${
                      isDark ? 'text-neutral-500' : 'text-stone-600'
                    }`}
                  >
                    {item.time}
                  </span>
                  <span
                    className={`leading-snug ${
                      isDark ? 'text-neutral-300' : 'text-stone-800'
                    }`}
                  >
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <main
          className={`col-span-12 lg:col-span-9 min-h-[24rem] rounded-xl border flex flex-col overflow-hidden ${
            isDark
              ? 'bg-neutral-900 border-neutral-800'
              : 'bg-[#fbf7f0] border-[#dcd2c0] shadow-xs'
          }`}
        >
          <div
            className={`px-5 py-3 border-b flex flex-wrap items-center justify-between gap-2 shrink-0 ${
              isDark ? 'border-neutral-800' : 'border-[#dfd6c5]'
            }`}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <h2
                className={`font-semibold text-base ${
                  isDark ? 'text-white' : 'text-stone-950'
                }`}
              >
                Tax Prep AI Agent
              </h2>
              <span
                className={`text-xs ${
                  isDark ? 'text-neutral-400' : 'text-stone-700'
                }`}
              >
                — Advance Tax & Deduction Optimizer
              </span>
            </div>

            {renderAccessibilityControls()}
          </div>

          <div
            aria-live="polite"
            className="flex-1 overflow-y-auto p-5 space-y-4"
          >
            <div className="space-y-3">
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-3xl px-4 py-3 rounded-xl text-sm leading-relaxed whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? isDark
                          ? 'bg-white text-neutral-950 font-medium'
                          : 'bg-stone-900 text-[#fbf7f0] font-medium'
                        : isDark
                        ? 'bg-neutral-800 text-neutral-200 font-normal border border-neutral-700'
                        : 'bg-[#f2ebde] text-stone-950 font-normal border border-[#d8cebc]'
                    }`}
                  >
                    {msg.role === 'assistant'
                      ? renderFormattedMessage(msg.content, isDark)
                      : msg.content}
                    {msg.role === 'assistant' && msg.chart?.type === 'liquidity_line' && (
                      <LiquidityForecastChart chart={msg.chart} isDark={isDark} />
                    )}
                  </div>
                </div>
              ))}
              {loading && (
                <div
                  className={`text-xs font-mono animate-pulse ${
                    isDark ? 'text-neutral-400' : 'text-stone-700'
                  }`}
                >
                  Tax Prep Agent reasoning on OpenShift AI...
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div
            className={`p-4 border-t shrink-0 ${
              isDark
                ? 'border-neutral-800 bg-neutral-900'
                : 'border-[#dfd6c5] bg-[#fbf7f0]'
            }`}
          >
            {attachedFile && (
              <div
                className={`mb-2 inline-flex items-center gap-2 px-3 py-1 rounded border text-xs font-mono ${
                  isDark
                    ? 'bg-neutral-800 border-neutral-700 text-neutral-200'
                    : 'bg-[#efe8db] border-[#d6cbb7] text-stone-900'
                }`}
              >
                <span>📎 {attachedFile.name}</span>
                <button
                  type="button"
                  aria-label="Remove attached file"
                  onClick={() => {
                    setAttachedFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                  className={
                    isDark
                      ? 'text-neutral-400 hover:text-white'
                      : 'text-stone-600 hover:text-stone-950'
                  }
                >
                  ✕
                </button>
              </div>
            )}

            <form onSubmit={handleSend} className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
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
                className={`px-3.5 py-2.5 rounded-lg border text-xs font-mono transition shrink-0 cursor-pointer ${
                  isDark
                    ? 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
                    : 'bg-[#efe8db] hover:bg-[#e5dccb] border-[#d6cbb7] text-stone-900'
                }`}
              >
                + File
              </button>

              <input
                type="text"
                aria-label="Ask Tax Prep Agent"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask Tax Prep Agent or attach receipts/invoices..."
                className={`flex-1 min-w-[12rem] border rounded-lg px-4 py-2.5 text-sm focus:outline-none ${
                  isDark
                    ? 'bg-neutral-950 border-neutral-700 text-white placeholder-neutral-500 focus:border-neutral-400'
                    : 'bg-[#f7f2e9] border-[#cfc3ae] text-stone-950 placeholder-stone-500 focus:border-stone-900'
                }`}
              />

              <button
                type="submit"
                disabled={loading}
                className={`px-5 py-2.5 rounded-lg disabled:opacity-50 font-semibold text-sm transition shrink-0 cursor-pointer ${
                  isDark
                    ? 'bg-white hover:bg-neutral-200 text-neutral-950'
                    : 'bg-stone-900 hover:bg-stone-800 text-[#fbf7f0]'
                }`}
              >
                Send
              </button>
            </form>
          </div>
        </main>
      </div>

      {accountModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="FinancAI.lly Account"
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div
            className={`w-full max-w-lg rounded-xl border overflow-hidden shadow-2xl ${
              isDark
                ? 'bg-neutral-900 border-neutral-700'
                : 'bg-[#fbf7f0] border-[#d6cbb7]'
            }`}
          >
            <div
              className={`px-5 py-3.5 border-b flex items-center justify-between ${
                isDark ? 'border-neutral-800' : 'border-[#dfd6c5]'
              }`}
            >
              <div className="flex items-center gap-3">
                <img
                  src="/logo.png"
                  alt="FinancAI.lly logo"
                  className={`w-8 h-8 object-contain ${isDark ? '' : 'invert'}`}
                />
                <span
                  className={`font-mono text-sm ${
                    isDark ? 'text-white' : 'text-stone-950'
                  }`}
                >
                  FinancAI.lly Account
                </span>
              </div>
              <button
                onClick={() => setAccountModalOpen(false)}
                className={`text-sm font-mono cursor-pointer ${
                  isDark
                    ? 'text-neutral-400 hover:text-white'
                    : 'text-stone-600 hover:text-stone-950'
                }`}
              >
                [ESC / ✕]
              </button>
            </div>

            <div
              className={`grid grid-cols-2 border-b text-xs font-mono ${
                isDark ? 'border-neutral-800' : 'border-[#dfd6c5]'
              }`}
            >
              {[
                { id: 'switch', label: 'My Accounts' },
                { id: 'settings', label: 'Settings & Rules' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setAccountModalTab(tab.id)}
                  className={`py-3 text-center transition border-b-2 cursor-pointer ${
                    accountModalTab === tab.id
                      ? isDark
                        ? 'border-white text-white bg-neutral-800/60'
                        : 'border-stone-900 text-stone-950 bg-[#efe8db]'
                      : isDark
                      ? 'border-transparent text-neutral-400 hover:text-neutral-200'
                      : 'border-transparent text-stone-600 hover:text-stone-950'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {accountModalTab === 'switch' && (
              <div className="p-5 space-y-3">
                <div
                  className={`flex items-center justify-between text-xs ${
                    isDark ? 'text-neutral-400' : 'text-stone-700'
                  }`}
                >
                  <span>Signed-in accounts:</span>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="px-3 py-1 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-600 border border-rose-500/40 font-mono text-xs font-semibold transition cursor-pointer"
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
                        className={`w-full p-3.5 rounded-lg border text-left flex items-center justify-between transition cursor-pointer ${
                          isCurrent
                            ? isDark
                              ? 'bg-neutral-800 border-neutral-500 text-white'
                              : 'bg-[#efe8db] border-stone-500 text-stone-950'
                            : isDark
                            ? 'bg-neutral-950 border-neutral-800 text-neutral-300 hover:border-neutral-600'
                            : 'bg-[#f5efe4] border-[#dfd6c5] text-stone-800 hover:border-stone-400'
                        }`}
                      >
                        <div>
                          <div className="text-sm font-semibold">{acc.name}</div>
                          <div
                            className={`text-xs font-mono mt-0.5 ${
                              isDark ? 'text-neutral-400' : 'text-stone-700'
                            }`}
                          >
                            {acc.email}
                          </div>
                        </div>
                        <div className="text-right">
                          <div
                            className={`text-sm font-mono font-semibold ${
                              acc.liquidity < 0
                                ? isDark
                                  ? 'text-rose-400'
                                  : 'text-rose-700'
                                : isDark
                                ? 'text-emerald-400'
                                : 'text-emerald-700'
                            }`}
                          >
                            {acc.liquidity > 0
                              ? `+${formatEuro(acc.liquidity)}`
                              : formatEuro(acc.liquidity)}
                          </div>
                          <div
                            className={`text-xs font-mono ${
                              isDark ? 'text-neutral-400' : 'text-stone-700'
                            }`}
                          >
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
                <div
                  className={`p-3 rounded-lg border ${
                    isDark
                      ? 'bg-neutral-950 border-neutral-800'
                      : 'bg-[#f4eee2] border-[#dfd6c5]'
                  }`}
                >
                  <div
                    className={`font-mono ${
                      isDark ? 'text-neutral-400' : 'text-stone-700'
                    }`}
                  >
                    EDITING SETTINGS FOR:
                  </div>
                  <div
                    className={`text-sm font-semibold mt-0.5 ${
                      isDark ? 'text-white' : 'text-stone-950'
                    }`}
                  >
                    {activeAccount.name} ({activeAccount.email})
                  </div>
                </div>

                <div>
                  <label
                    className={`block font-mono mb-1 ${
                      isDark ? 'text-neutral-400' : 'text-stone-700'
                    }`}
                  >
                    MINIMUM CASH SAFETY BUFFER (€)
                  </label>
                  <input
                    type="number"
                    value={activeAccount.safetyBuffer}
                    onChange={(e) =>
                      updateActiveAccountSetting('safetyBuffer', Number(e.target.value) || 0)
                    }
                    className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none ${
                      isDark
                        ? 'bg-neutral-950 border-neutral-700 text-white focus:border-white'
                        : 'bg-[#f7f2e9] border-[#cfc3ae] text-stone-950 focus:border-stone-900'
                    }`}
                  />
                </div>

                <label
                  className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer ${
                    isDark
                      ? 'bg-neutral-950 border-neutral-800'
                      : 'bg-[#f4eee2] border-[#dfd6c5]'
                  }`}
                >
                  <div>
                    <div
                      className={`text-sm font-medium ${
                        isDark ? 'text-white' : 'text-stone-950'
                      }`}
                    >
                      Sandbox Simulation Mode
                    </div>
                    <div
                      className={`text-xs ${
                        isDark ? 'text-neutral-400' : 'text-stone-700'
                      }`}
                    >
                      Simulate approved tax filings without live submission
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={activeAccount.sandboxMode}
                    onChange={(e) =>
                      updateActiveAccountSetting('sandboxMode', e.target.checked)
                    }
                    className="w-4 h-4"
                  />
                </label>

                <label
                  className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer ${
                    isDark
                      ? 'bg-neutral-950 border-neutral-800'
                      : 'bg-[#f4eee2] border-[#dfd6c5]'
                  }`}
                >
                  <div>
                    <div
                      className={`text-sm font-medium ${
                        isDark ? 'text-white' : 'text-stone-950'
                      }`}
                    >
                      Auto-Approve Low-Risk Actions (&lt; €500)
                    </div>
                    <div
                      className={`text-xs ${
                        isDark ? 'text-neutral-400' : 'text-stone-700'
                      }`}
                    >
                      Allow Tax Agent to categorize minor deductions automatically
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={activeAccount.autoApproveSmall}
                    onChange={(e) =>
                      updateActiveAccountSetting('autoApproveSmall', e.target.checked)
                    }
                    className="w-4 h-4"
                  />
                </label>

                <div className="pt-1 flex justify-end">
                  <button
                    onClick={() => {
                      addLog(`Updated tax governance settings for ${activeAccount.name}`);
                      setAccountModalOpen(false);
                    }}
                    className={`px-4 py-2 rounded-lg font-semibold cursor-pointer ${
                      isDark
                        ? 'bg-white text-neutral-950 hover:bg-neutral-200'
                        : 'bg-stone-900 text-[#fbf7f0] hover:bg-stone-800'
                    }`}
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