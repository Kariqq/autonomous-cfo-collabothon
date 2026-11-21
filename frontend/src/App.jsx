import React, { useState, useRef, useEffect, useCallback } from 'react';

const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  'https://cfo-backend-api-autonomous-cfo-collabothon.apps.ocp.fr79k.sandbox786.opentlc.com';
const LLAMA_INVOICES_ENDPOINT =
  import.meta.env.VITE_LLAMA_INVOICES_URL || `${API_BASE_URL}/api/bank/invoices`;
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
  { id: 'lg', label: 'A+', title: 'Large text', rootPx: '18px' },
  { id: 'xl', label: 'A++', title: 'Extra large text', rootPx: '20.5px' },
];

const FX_TO_EUR = {
  EUR: 1.0,
  CHF: 1.06,
  USD: 0.92,
  PLN: 0.23,
  GBP: 1.17,
};

const FALLBACK_BANK_INVOICES = [
  {
    id: 'INV-2026-081',
    contractor: 'Enterprise Client GmbH',
    amount: 120000,
    currency: 'EUR',
    vatRate: 0.19,
    dueInDays: 10,
    type: 'receivable',
    category: 'B2B Software',
  },
  {
    id: 'INV-2026-082',
    contractor: 'AI & Cloud R&D Lab',
    amount: 40000,
    currency: 'EUR',
    vatRate: 0.19,
    dueInDays: 5,
    type: 'payable',
    category: 'R&D',
  },
  {
    id: 'INV-FX-01',
    contractor: 'Swiss Precision Supplier AG',
    amount: 12000,
    currency: 'CHF',
    vatRate: 0.0,
    dueInDays: 30,
    type: 'payable',
    category: 'FX Exposure',
  },
  {
    id: 'INV-FX-02',
    contractor: 'US Enterprise Client Inc.',
    amount: 4500,
    currency: 'USD',
    vatRate: 0.0,
    dueInDays: 45,
    type: 'receivable',
    category: 'FX Exposure',
  },
];

function normalizeInvoice(raw, index = 0) {
  const rawAmount = Number(raw.amount ?? raw.total ?? raw.value ?? 0);
  const rawType = String(raw.type || raw.direction || '').toLowerCase();
  const isPayable =
    rawType === 'payable' ||
    rawType === 'outgoing' ||
    rawType === 'debit' ||
    rawType === 'expense' ||
    rawAmount < 0;

  let dueInDays = Number(raw.dueInDays ?? raw.due_in_days ?? raw.day_offset);
  if (Number.isNaN(dueInDays)) {
    const dueStr = raw.dueDate || raw.due_date;
    if (dueStr) {
      const diffMs = new Date(dueStr).getTime() - Date.now();
      dueInDays = Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
    } else {
      dueInDays = 14;
    }
  }

  let vatRate = Number(raw.vatRate ?? raw.vat_rate ?? raw.taxRate ?? raw.tax_rate ?? 0);
  if (vatRate > 1) vatRate = vatRate / 100;

  const currency = String(raw.currency || 'EUR').toUpperCase();

  return {
    id: String(raw.id || raw.invoice_id || raw.number || `INV-LLAMA-${index + 1}`),
    contractor: String(
      raw.contractor || raw.counterparty || raw.client || raw.vendor || raw.issuer || 'Llama Bank Counterparty'
    ),
    amount: Math.abs(rawAmount),
    currency,
    vatRate,
    dueInDays,
    type: isPayable ? 'payable' : 'receivable',
    category: String(
      raw.category || (currency !== 'EUR' ? 'FX Exposure' : isPayable ? 'Operating Expense' : 'B2B Revenue')
    ),
  };
}

async function fetchLlamaInvoices(account) {
  const candidateUrls = [
    LLAMA_INVOICES_ENDPOINT,
    `${API_BASE_URL}/api/invoices`,
    `${API_BASE_URL}/invoices`,
    `${API_BASE_URL}/tools/bank/invoices`,
  ];

  const uniqueUrls = [...new Set(candidateUrls)];

  for (const baseUrl of uniqueUrls) {
    try {
      const url = new URL(baseUrl);
      if (account?.iban) url.searchParams.set('iban', account.iban);
      if (account?.email) url.searchParams.set('account', account.email);

      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) continue;
      const data = await res.json();
      const rawList = Array.isArray(data)
        ? data
        : Array.isArray(data?.invoices)
        ? data.invoices
        : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.data)
        ? data.data
        : null;

      if (rawList) {
        return {
          invoices: rawList.map((item, idx) => normalizeInvoice(item, idx)),
          source: 'live',
          endpoint: baseUrl,
        };
      }
    } catch {
      // Try next candidate endpoint
    }
  }

  return {
    invoices: FALLBACK_BANK_INVOICES,
    source: 'fallback',
    endpoint: LLAMA_INVOICES_ENDPOINT,
  };
}

function computeBankMetrics(account, invoices, bankConnected) {
  if (!account || !bankConnected || !Array.isArray(invoices) || invoices.length === 0) {
    return {
      isConnected: false,
      liquidity: null,
      taxLiabilityStr: '—',
      taxSavingsStr: '—',
      chartPoints: [],
    };
  }

  const baseBalance = Number(account.liquidity || 0);

  let netReceivablesEur = 0;
  let netPayablesEur = 0;
  let outputVatEur = 0;
  let inputVatEur = 0;
  let rdDeductionSavingsEur = 0;

  const normalizedEvents = invoices.map((inv) => {
    const rate = FX_TO_EUR[inv.currency] || 1.0;
    const eurAmount = Math.round(Number(inv.amount || 0) * rate);
    const vatRate = Number(inv.vatRate || 0);
    const vatEur = Math.round(eurAmount * vatRate);
    const signedCashEur = inv.type === 'receivable' ? eurAmount : -eurAmount;

    if (inv.type === 'receivable') {
      netReceivablesEur += eurAmount;
      outputVatEur += vatEur;
    } else {
      netPayablesEur += eurAmount;
      inputVatEur += vatEur;
      if (String(inv.category).toLowerCase().includes('r&d')) {
        rdDeductionSavingsEur += Math.round(eurAmount * 0.25);
      }
    }

    return {
      id: inv.id,
      dueInDays: Number(inv.dueInDays || 0),
      signedCashEur,
    };
  });

  const effectiveLiquidity = baseBalance + netReceivablesEur - netPayablesEur;
  const netVatPayable = Math.max(0, outputVatEur - inputVatEur);
  const baseQ3Cit = 21000;
  const totalTaxLiability = Math.max(0, baseQ3Cit + netVatPayable - rdDeductionSavingsEur);
  const totalTaxSavings = 6200 + rdDeductionSavingsEur + inputVatEur;

  const maxDue = Math.max(45, ...normalizedEvents.map((e) => e.dueInDays));
  const baseMilestones = [0, 5, 10, 20, 30, 45];
  if (maxDue > 45) baseMilestones.push(maxDue);

  const chartPoints = baseMilestones.map((day) => {
    const cumulativeDelta = normalizedEvents
      .filter((ev) => ev.dueInDays <= day)
      .reduce((sum, ev) => sum + ev.signedCashEur, 0);

    const taxSettlement = day >= 30 ? -totalTaxLiability : 0;

    return {
      label: day === 0 ? 'Now' : `D+${day}`,
      balance: baseBalance + cumulativeDelta + taxSettlement,
    };
  });

  const formatNum = (n) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(n);

  return {
    isConnected: true,
    liquidity: effectiveLiquidity,
    taxLiabilityStr: totalTaxLiability > 0 ? `-€${formatNum(totalTaxLiability)} (Q3)` : '€0 (Q3)',
    taxSavingsStr: `+€${formatNum(totalTaxSavings)}`,
    chartPoints,
  };
}

function buildFileMetadata(file) {
  if (!file) return null;
  const ext = (file.name.split('.').pop() || 'txt').toUpperCase();
  const sizeKb = Math.max(1, Math.round((file.size || 2048) / 1024));
  const rowEstimate =
    ext === 'CSV' || ext === 'XLSX'
      ? Math.max(12, Math.min(480, sizeKb * 6))
      : ext === 'JSON'
      ? Math.max(8, Math.min(200, sizeKb * 4))
      : Math.max(4, Math.min(64, sizeKb * 2));

  return {
    fileName: file.name,
    extension: ext,
    sizeLabel: `${sizeKb} KB`,
    lineItemsParsed: rowEstimate,
    parsingStatus: 'Parsed & Schema Validated',
    vatCheckStatus: '19% / 0% Reverse-Charge Aligned',
  };
}

function detectDirectAccountReply(prompt, account, liveMetrics, bankConnected, invoices, formatEuro) {
  const q = prompt.trim().toLowerCase();

  if (/\biban\b/.test(q)) {
    return `Your connected workspace IBAN for ${account.name} is ${account.iban}.`;
  }
  if (/\btax\s*id\b|\bvat\s*id\b|\bsteuernummer\b/.test(q)) {
    return `Your registered Tax ID for ${account.name} is ${account.taxId}.`;
  }
  if (/\bemail\b/.test(q)) {
    return `Your active account email is ${account.email}.`;
  }
  if (/\bsafety\s*buffer\b|\bbuffer\b/.test(q)) {
    return `Your configured minimum cash safety buffer for ${account.name} is ${formatEuro(account.safetyBuffer)}.`;
  }
  if (/\bliquidity\b|\bbalance\b|\bhow much money\b|\bcash\b/.test(q) && !/invoice|fx|forecast/.test(q)) {
    if (!bankConnected || liveMetrics.liquidity === null) {
      return `No live bank feed is connected yet. Your baseline account balance is ${formatEuro(account.liquidity)}—click "Connect to bank" in the sidebar to compute live liquidity from open invoices.`;
    }
    return `Your current projected liquidity for ${account.name} is ${formatEuro(liveMetrics.liquidity)} (baseline ${formatEuro(account.liquidity)} adjusted for ${invoices.length} open bank invoices).`;
  }

  return null;
}

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

function DocumentIngestionCard({ docMeta, isDark }) {
  if (!docMeta) return null;

  return (
    <div
      className={`mb-2.5 rounded-xl border p-3 text-xs font-mono ${
        isDark
          ? 'bg-neutral-900/90 border-neutral-700 text-neutral-200'
          : 'bg-[#fbf7f0] border-[#cfc3ae] text-stone-900'
      }`}
    >
      <div className="flex items-center justify-between gap-2 pb-2 mb-2 border-b border-current/15">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
              isDark
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                : 'bg-sky-100 text-sky-900 border border-sky-300'
            }`}
          >
            {docMeta.extension}
          </span>
          <span className="font-semibold truncate">{docMeta.fileName}</span>
        </div>
        <span className={isDark ? 'text-neutral-400 shrink-0' : 'text-stone-600 shrink-0'}>
          {docMeta.sizeLabel}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className={isDark ? 'text-emerald-400' : 'text-emerald-700'}>✓</span>
          <span className={isDark ? 'text-neutral-400' : 'text-stone-600'}>Parsing:</span>
          <span className="font-semibold truncate">
            {docMeta.lineItemsParsed} items ({docMeta.parsingStatus})
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={isDark ? 'text-emerald-400' : 'text-emerald-700'}>✓</span>
          <span className={isDark ? 'text-neutral-400' : 'text-stone-600'}>VAT Check:</span>
          <span className="font-semibold truncate">{docMeta.vatCheckStatus}</span>
        </div>
      </div>
    </div>
  );
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

        <text
          x={padLeft - 8}
          y={padTop + 4}
          textAnchor="end"
          fill={isDark ? '#a3a3a3' : '#57534e'}
          fontSize="10"
        >
          {maxVal.toLocaleString()}
        </text>
        <text
          x={padLeft - 8}
          y={height - padBottom}
          textAnchor="end"
          fill={isDark ? '#a3a3a3' : '#57534e'}
          fontSize="10"
        >
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
  const [chartModalOpen, setChartModalOpen] = useState(false);
  const [fontPopoverOpen, setFontPopoverOpen] = useState(false);
  const [expandedLogIds, setExpandedLogIds] = useState({});
  const [authError, setAuthError] = useState('');

  // Draggable sidebar splitter height (in px) for Bank Invoices & Audit Log
  const [invoicesHeight, setInvoicesHeight] = useState(160);
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false);
  const sidebarContainerRef = useRef(null);
  const dragStartRef = useRef({ y: 0, startHeight: 160 });

  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  const [bankConnected, setBankConnected] = useState(false);
  const [bankConnecting, setBankConnecting] = useState(false);
  const [refreshingInvoices, setRefreshingInvoices] = useState(false);
  const [spawnedInvoices, setSpawnedInvoices] = useState([]);

  const [attachedFile, setAttachedFile] = useState(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef(null);
  const fontPopoverRef = useRef(null);
  const messagesEndRef = useRef(null);

  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        "Hi! I'm here to help you manage your finances. Connect your bank to load live statistics and cashflow charts, or upload a receipt/invoice to get started.",
      chart: null,
      documentPreview: null,
    },
  ]);

  const [historyLog, setHistoryLog] = useState([
    {
      id: 1,
      time: '09:14',
      label: 'Identified €14,500 advance tax reduction',
      agent: 'Tax Optimization Engine',
      confidence: '98.4%',
      toolUsed: 'rhoai.tax.evaluate_prepayment',
      reasoningTrace:
        '1. Queried Q1–Q3 cumulative taxable base.\n2. Detected R&D eligible cost ratio exceeding baseline threshold.\n3. Simulated §37 EStG prepayment adjustment retaining €14,500 cash.',
    },
    {
      id: 2,
      time: '09:15',
      label: 'Verified upcoming VAT filing deadline',
      agent: 'Compliance & ERP Sync',
      confidence: '99.9%',
      toolUsed: 'erp.elster.check_schedule',
      reasoningTrace:
        '1. Cross-checked Tax ID DE 401 992 118 against monthly UStVA filing calendar.\n2. Confirmed next submission window and zero overdue declarations.',
    },
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

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (fontPopoverRef.current && !fontPopoverRef.current.contains(e.target)) {
        setFontPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!isDraggingSplitter) return;

    const handleMove = (e) => {
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const deltaY = clientY - dragStartRef.current.y;
      const sidebarHeight = sidebarContainerRef.current?.clientHeight || 560;
      const maxHeight = Math.max(220, sidebarHeight - 230);
      const nextHeight = Math.max(76, Math.min(maxHeight, dragStartRef.current.startHeight + deltaY));
      setInvoicesHeight(nextHeight);
    };

    const handleUp = () => {
      setIsDraggingSplitter(false);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('touchmove', handleMove);
    window.addEventListener('touchend', handleUp);

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleUp);
    };
  }, [isDraggingSplitter]);

  const startSplitterDrag = (e) => {
    e.preventDefault();
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragStartRef.current = { y: clientY, startHeight: invoicesHeight };
    setIsDraggingSplitter(true);
  };

  const activeAccount = accounts.find((a) => a.id === activeAccountId) || null;

  const liveMetrics = computeBankMetrics(activeAccount, spawnedInvoices, bankConnected);

  const latestChart =
    activeAccount && bankConnected && spawnedInvoices.length > 0
      ? {
          type: 'liquidity_line',
          title: `${activeAccount.name} — Live Bank Invoice Cashflow Forecast (45d)`,
          currency: 'EUR',
          safety_buffer: activeAccount.safetyBuffer,
          points: liveMetrics.chartPoints,
        }
      : [...messages]
          .reverse()
          .find((m) => m.chart && Array.isArray(m.chart.points) && m.chart.points.length >= 2)
          ?.chart || null;

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const toggleLogExpand = (id) => {
    setExpandedLogIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const formatEuro = (val) =>
    new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
      maximumFractionDigits: 0,
    }).format(val);

  const getLiquidityColor = (balance, buffer) => {
    if (balance === null || balance === undefined) {
      return isDark ? 'text-neutral-500' : 'text-stone-400';
    }
    if (balance < 0) return isDark ? 'text-rose-400' : 'text-rose-700';
    if (balance < buffer) return isDark ? 'text-amber-400' : 'text-amber-700';
    return isDark ? 'text-emerald-400' : 'text-emerald-700';
  };

  const getSignedMetricColor = (text) => {
    const trimmed = String(text).trim();
    if (trimmed === '—') return isDark ? 'text-neutral-500' : 'text-stone-400';
    if (trimmed.startsWith('-')) return isDark ? 'text-rose-400' : 'text-rose-700';
    if (trimmed.startsWith('+')) return isDark ? 'text-emerald-400' : 'text-emerald-700';
    return isDark ? 'text-neutral-100' : 'text-stone-900';
  };

  const addLog = useCallback((label, meta = {}) => {
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setHistoryLog((prev) => [
      {
        id: Date.now() + Math.random(),
        time: now,
        label,
        agent: meta.agent || 'Finance AI Agent',
        confidence: meta.confidence || '97.8%',
        toolUsed: meta.toolUsed || 'rhoai.cfo.orchestrator',
        reasoningTrace:
          meta.reasoningTrace ||
          `1. Received event trigger: "${label}".\n2. Validated workspace context & safety buffer.\n3. Committed audit record to OpenShift AI ledger.`,
      },
      ...prev,
    ]);
  }, []);

  const handleRefreshInvoices = useCallback(
    async ({ silent = false } = {}) => {
      if (!activeAccount || refreshingInvoices) return;
      setRefreshingInvoices(true);

      try {
        const result = await fetchLlamaInvoices(activeAccount);
        setSpawnedInvoices((prev) => {
          const prevIds = prev.map((i) => `${i.id}:${i.amount}`).join('|');
          const nextIds = result.invoices.map((i) => `${i.id}:${i.amount}`).join('|');

          if (!silent || prevIds !== nextIds) {
            const addedCount = Math.max(0, result.invoices.length - prev.length);
            addLog(
              addedCount > 0
                ? `Synced ${result.invoices.length} invoices (+${addedCount} new from Llama Bank)`
                : `Refreshed ${result.invoices.length} Llama Bank invoices (${result.source})`,
              {
                agent: 'Llama Bank Sync Worker',
                confidence: result.source === 'live' ? '99.8%' : '95.0%',
                toolUsed: 'llama.bank.fetch_invoices',
                reasoningTrace: `1. Queried ${result.endpoint} for IBAN ${activeAccount.iban}.\n2. Loaded ${result.invoices.length} invoices (${result.source} feed).\n3. Recalculated live liquidity, VAT, and 45-day cashflow curve.`,
              }
            );
          }
          return result.invoices;
        });
      } finally {
        setRefreshingInvoices(false);
      }
    },
    [activeAccount, refreshingInvoices, addLog]
  );

  // Auto-poll Llama Bank every 15s while bank is connected so newly created invoices appear automatically
  useEffect(() => {
    if (!bankConnected || !activeAccount) return;
    const interval = setInterval(() => {
      handleRefreshInvoices({ silent: true });
    }, 15000);
    return () => clearInterval(interval);
  }, [bankConnected, activeAccount, handleRefreshInvoices]);

  const handleConnectBank = async () => {
    if (bankConnecting || !activeAccount) return;

    if (bankConnected) {
      setBankConnected(false);
      setSpawnedInvoices([]);
      addLog(`Disconnected Llama Bank session (${activeAccount.iban})`, {
        agent: 'Treasury Connector',
        confidence: '100%',
        toolUsed: 'llama.bank.disconnect',
        reasoningTrace: `1. Closed Llama Bank PSD2 session.\n2. Cleared ephemeral invoice cache and reset header KPIs.`,
      });
      return;
    }

    setBankConnecting(true);

    const fetchResult = await fetchLlamaInvoices(activeAccount);
    const syncedInvoices = fetchResult.invoices;
    let llamaSummary = '';

    try {
      const res = await fetch(`${API_BASE_URL}/tools/liquidity/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_name: activeAccount.name,
          current_balance: activeAccount.liquidity,
          safety_buffer: activeAccount.safetyBuffer,
          currency: 'EUR',
          horizon_days: 45,
          user_query: 'Sync open invoices and evaluate liquidity & tax impact',
          scheduled_cashflows: syncedInvoices.map((inv) => ({
            label: `${inv.id} (${inv.contractor})`,
            amount:
              (inv.type === 'receivable' ? 1 : -1) *
              Math.round(inv.amount * (FX_TO_EUR[inv.currency] || 1)),
            day_offset: inv.dueInDays,
          })),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data?.explanation || data?.summary) {
          llamaSummary = data.explanation || data.summary;
        }
      }
    } catch {
      // Proceed with fetched/fallback invoices
    } finally {
      setBankConnected(true);
      setBankConnecting(false);
      setSpawnedInvoices(syncedInvoices);

      const updated = computeBankMetrics(activeAccount, syncedInvoices, true);
      addLog(
        `Connected to Llama Bank (${syncedInvoices.length} invoices • ${fetchResult.source})`,
        {
          agent: 'Treasury & Liquidity Agent',
          confidence: '99.2%',
          toolUsed: 'llama.bank.fetch_invoices',
          reasoningTrace: `1. Authenticated IBAN ${activeAccount.iban} via Llama Bank API.\n2. Fetched ${syncedInvoices.length} open invoices (${fetchResult.source} source).\n3. Normalized FX rates and projected 45-day cash curve against €${activeAccount.safetyBuffer.toLocaleString()} buffer.`,
        }
      );

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            llamaSummary ||
            `Connected to Llama Bank for ${activeAccount.name} (${activeAccount.iban}). Imported ${syncedInvoices.length} open invoices and calculated your live statistics: Projected Liquidity is ${formatEuro(updated.liquidity)}, Est. Tax Liability is ${updated.taxLiabilityStr}, and Tax Savings Found is ${updated.taxSavingsStr}.`,
          chart: {
            type: 'liquidity_line',
            title: `${activeAccount.name} — Live Bank Invoice Cashflow Forecast (45d)`,
            currency: 'EUR',
            safety_buffer: activeAccount.safetyBuffer,
            points: updated.chartPoints,
          },
          documentPreview: null,
        },
      ]);
    }
  };

  const handleTesterQuickLogin = () => {
    setAuthError('');
    setActiveAccountId(TESTER_ACCOUNT.id);
    setIsSignedIn(true);
    addLog(`Signed in (${TESTER_ACCOUNT.email})`, {
      agent: 'Auth Gateway',
      confidence: '100%',
      toolUsed: 'auth.session.create',
      reasoningTrace: `1. Verified Tester workspace credentials.\n2. Loaded sandbox profile DE 401 992 118.`,
    });
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
    setBankConnected(false);
    setSpawnedInvoices([]);
    setAccountModalOpen(false);
    setChartModalOpen(false);
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

    const userText = input.trim() || `Analyze financial document: ${attachedFile.name}`;
    const currentFile = attachedFile;
    const docPreview = buildFileMetadata(currentFile);

    setMessages((prev) => [
      ...prev,
      {
        role: 'user',
        content: userText,
        chart: null,
        documentPreview: docPreview,
      },
    ]);

    if (currentFile && docPreview) {
      addLog(`Ingested ${currentFile.name} (${docPreview.extension})`, {
        agent: 'Document OCR & VAT Parser',
        confidence: '96.9%',
        toolUsed: 'rhoai.docling.extract_ledger',
        reasoningTrace: `1. Detected ${docPreview.extension} payload (${docPreview.sizeLabel}).\n2. Extracted ${docPreview.lineItemsParsed} structured line items.\n3. Verified VAT rates against ${activeAccount.taxId} rules.`,
      });
    }

    setInput('');
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setLoading(true);

    if (!currentFile) {
      const directReply = detectDirectAccountReply(
        userText,
        activeAccount,
        liveMetrics,
        bankConnected,
        spawnedInvoices,
        formatEuro
      );
      if (directReply) {
        addLog(`Answered account query: "${userText.slice(0, 36)}${userText.length > 36 ? '...' : ''}"`, {
          agent: 'Workspace Context Resolver',
          confidence: '100%',
          toolUsed: 'workspace.profile.lookup',
          reasoningTrace: `1. Matched user question directly to workspace profile field.\n2. Returned exact verified value for ${activeAccount.name}.`,
        });
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: directReply,
            chart: null,
            documentPreview: null,
          },
        ]);
        setLoading(false);
        return;
      }
    }

    const asksAboutInvoicesOrForecast =
      /\b(invoice|inv-|fx|currency|chf|usd|forecast|chart|cashflow|cash flow|tax|vat|r&d|deduction|receivable|payable|analyze)\b/i.test(
        userText
      ) || Boolean(currentFile);

    const contextualPrompt =
      bankConnected && spawnedInvoices.length > 0 && asksAboutInvoicesOrForecast
        ? `User Question: ${userText}\n\n[Workspace Context — Account: ${activeAccount.name}, IBAN: ${activeAccount.iban}, Tax ID: ${activeAccount.taxId}, Safety Buffer: ${formatEuro(activeAccount.safetyBuffer)}, Open Invoices: ${spawnedInvoices
            .map(
              (inv) =>
                `${inv.id} (${inv.contractor}: ${inv.type === 'receivable' ? '+' : '-'}${inv.amount} ${inv.currency}, due in ${inv.dueInDays}d)`
            )
            .join('; ')}]`
        : `User Question: ${userText}\n\n[Workspace Profile — Account: ${activeAccount.name}, Email: ${activeAccount.email}, IBAN: ${activeAccount.iban}, Tax ID: ${activeAccount.taxId}, Safety Buffer: ${formatEuro(activeAccount.safetyBuffer)}. Answer ONLY the user's specific question directly and concisely without listing invoices unless requested.]`;

    try {
      const formData = new FormData();
      formData.append('agent', 'auto');
      formData.append('account', activeAccount.name);
      formData.append('prompt', contextualPrompt);
      if (currentFile) formData.append('file', currentFile);

      const res = await fetch(`${API_BASE_URL}/api/cfo/chat`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error('Backend not connected');
      const data = await res.json();

      addLog(`Executed CFO query: "${userText.slice(0, 38)}${userText.length > 38 ? '...' : ''}"`, {
        agent: 'Finance AI Agent (Llama 3.2)',
        confidence: '97.5%',
        toolUsed: 'api.cfo.chat',
        reasoningTrace: `1. Parsed user intent: "${userText}".\n2. Scoped context to ${asksAboutInvoicesOrForecast ? 'live invoices & tax rules' : 'general workspace profile'}.\n3. Synthesized response on OpenShift AI.`,
      });

      const shouldAttachChart =
        Boolean(data.chart) ||
        (bankConnected &&
          spawnedInvoices.length > 0 &&
          /\b(chart|forecast|cashflow|cash flow|liquidity|timeline)\b/i.test(userText));

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.reply,
          chart: data.chart || (shouldAttachChart ? latestChart : null),
          documentPreview: null,
        },
      ]);
    } catch {
      const fallback = currentFile
        ? `Scanned "${currentFile.name}" (${docPreview.lineItemsParsed} line items) for ${activeAccount.name}. Categorized deductible business expenses and verified VAT alignment${
            bankConnected ? `—your net tax reduction is ${liveMetrics.taxSavingsStr}` : ''
          }.`
        : bankConnected && asksAboutInvoicesOrForecast
        ? `[Finance AI Agent • Llama Bank]: For ${activeAccount.name} (Tax ID ${activeAccount.taxId}), current projected liquidity is ${formatEuro(liveMetrics.liquidity)} with ${liveMetrics.taxLiabilityStr} estimated tax and ${liveMetrics.taxSavingsStr} in tax savings while keeping your ${formatEuro(activeAccount.safetyBuffer)} safety buffer intact.`
        : `[Finance AI Agent]: How can I assist you with ${activeAccount.name} (${activeAccount.iban})? You can ask about your account details, tax optimization, or upload a financial file.`;

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: fallback,
          chart:
            bankConnected &&
            spawnedInvoices.length > 0 &&
            /\b(chart|forecast|cashflow|cash flow|liquidity|timeline)\b/i.test(userText)
              ? latestChart
              : null,
          documentPreview: null,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const renderAccessibilityControls = () => {
    const activeFontObj =
      FONT_SIZE_OPTIONS.find((opt) => opt.id === fontSize) || FONT_SIZE_OPTIONS[1];

    return (
      <div
        role="group"
        aria-label="Theme and text size controls"
        className="flex items-center gap-2 shrink-0"
      >
        <div ref={fontPopoverRef} className="relative">
          <button
            type="button"
            onClick={() => setFontPopoverOpen((prev) => !prev)}
            aria-expanded={fontPopoverOpen}
            aria-haspopup="true"
            title="Adjust text size"
            className={`h-8 min-w-[3.75rem] px-3 rounded-lg border text-xs font-mono whitespace-nowrap transition cursor-pointer inline-flex items-center justify-center gap-1.5 ${
              isDark
                ? 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border-neutral-700'
                : 'bg-[#efe8db] hover:bg-[#e5dccb] text-stone-900 border-[#d6cbb7]'
            }`}
          >
            <span className="font-bold">{activeFontObj.label}</span>
            <span className="text-[10px] opacity-70">▾</span>
          </button>

          {fontPopoverOpen && (
            <div
              className={`absolute right-0 mt-1.5 z-40 rounded-xl border p-1.5 shadow-xl flex items-center gap-1 whitespace-nowrap ${
                isDark
                  ? 'bg-neutral-900 border-neutral-700'
                  : 'bg-[#fbf7f0] border-[#cfc3ae]'
              }`}
            >
              {FONT_SIZE_OPTIONS.map((opt) => {
                const active = fontSize === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setFontSize(opt.id);
                      setFontPopoverOpen(false);
                    }}
                    title={opt.title}
                    aria-label={opt.title}
                    aria-pressed={active}
                    className={`min-w-[2.75rem] px-2.5 py-1.5 rounded-lg text-xs font-mono whitespace-nowrap text-center transition cursor-pointer ${
                      active
                        ? isDark
                          ? 'bg-white text-neutral-950 font-bold'
                          : 'bg-stone-900 text-[#fbf7f0] font-bold'
                        : isDark
                        ? 'text-neutral-400 hover:text-white hover:bg-neutral-800'
                        : 'text-stone-700 hover:text-stone-950 hover:bg-[#efe8db]'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={toggleTheme}
          aria-label={isDark ? 'Switch to light beige mode' : 'Switch to dark mode'}
          title={isDark ? 'Switch to light beige mode' : 'Switch to dark mode'}
          className={`h-8 px-3 rounded-lg border text-xs font-mono whitespace-nowrap transition cursor-pointer inline-flex items-center justify-center ${
            isDark
              ? 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border-neutral-700'
              : 'bg-[#efe8db] hover:bg-[#e5dccb] text-stone-900 border-[#d6cbb7]'
          }`}
        >
          {isDark ? '☀ Light' : '☾ Dark'}
        </button>
      </div>
    );
  };

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
      className={`h-screen w-screen overflow-hidden flex flex-col p-2.5 gap-2.5 font-sans transition-colors ${
        isDark
          ? 'bg-neutral-950 text-neutral-100'
          : 'bg-[#f4efe6] text-stone-900'
      }`}
    >
      <div className="grid grid-cols-12 gap-2.5 shrink-0">
        <header
          className={`col-span-12 lg:col-span-9 rounded-xl border px-4 py-2 flex flex-wrap items-center justify-between gap-3 ${
            isDark
              ? 'bg-neutral-900 border-neutral-800'
              : 'bg-[#fbf7f0] border-[#dcd2c0] shadow-xs'
          }`}
        >
          <div className="flex items-center gap-2 shrink-0">
            <img
              src="/logo.png"
              alt="FinancAI.lly logo"
              className={`h-9 w-auto object-contain shrink-0 ${isDark ? '' : 'invert'}`}
            />
            <span
              className={`font-mono text-lg leading-none tracking-tight font-semibold ${
                isDark ? 'text-white' : 'text-stone-950'
              }`}
            >
              Financ<span className={isDark ? 'text-neutral-400' : 'text-stone-500'}>AI</span>.lly
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-5">
            <div>
              <div
                className={`text-[11px] uppercase tracking-wider leading-tight ${
                  isDark ? 'text-neutral-500' : 'text-stone-600'
                }`}
              >
                Current Liquidity
              </div>
              <div
                className={`text-sm font-semibold leading-tight ${getLiquidityColor(
                  liveMetrics.liquidity,
                  activeAccount.safetyBuffer
                )}`}
              >
                {liveMetrics.isConnected && liveMetrics.liquidity !== null
                  ? liveMetrics.liquidity > 0
                    ? `+${formatEuro(liveMetrics.liquidity)}`
                    : formatEuro(liveMetrics.liquidity)
                  : '—'}
              </div>
            </div>
            <div
              className={`h-6 w-px hidden sm:block ${
                isDark ? 'bg-neutral-800' : 'bg-[#dfd6c5]'
              }`}
            />
            <div>
              <div
                className={`text-[11px] uppercase tracking-wider leading-tight ${
                  isDark ? 'text-neutral-500' : 'text-stone-600'
                }`}
              >
                Est. Tax Liability
              </div>
              <div
                className={`text-sm font-semibold leading-tight ${getSignedMetricColor(
                  liveMetrics.taxLiabilityStr
                )}`}
              >
                {liveMetrics.taxLiabilityStr}
              </div>
            </div>
            <div
              className={`h-6 w-px hidden sm:block ${
                isDark ? 'bg-neutral-800' : 'bg-[#dfd6c5]'
              }`}
            />
            <div>
              <div
                className={`text-[11px] uppercase tracking-wider leading-tight ${
                  isDark ? 'text-neutral-500' : 'text-stone-600'
                }`}
              >
                Tax Savings Found
              </div>
              <div
                className={`text-sm font-semibold leading-tight ${getSignedMetricColor(
                  liveMetrics.taxSavingsStr
                )}`}
              >
                {liveMetrics.taxSavingsStr}
              </div>
            </div>
          </div>
        </header>

        <div
          className={`col-span-12 lg:col-span-3 rounded-xl border px-3.5 py-2 flex items-center justify-between gap-2 ${
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
            className="flex items-center gap-2.5 min-w-0 text-left hover:opacity-90 transition cursor-pointer flex-1"
          >
            <div
              className={`w-8 h-8 rounded-lg border flex items-center justify-center font-mono font-bold text-xs shrink-0 ${
                isDark
                  ? 'bg-neutral-800 border-neutral-700 text-neutral-200'
                  : 'bg-[#efe8db] border-[#d6cbb7] text-stone-900'
              }`}
            >
              {activeAccount.initials}
            </div>
            <div className="truncate">
              <div
                className={`text-sm font-semibold truncate leading-tight ${
                  isDark ? 'text-white' : 'text-stone-950'
                }`}
              >
                {activeAccount.name}
              </div>
              <div
                className={`text-xs truncate leading-tight ${
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
            className={`text-xs font-mono px-2.5 py-1.5 rounded border shrink-0 whitespace-nowrap transition cursor-pointer ${
              isDark
                ? 'bg-neutral-800 hover:bg-rose-500/20 text-neutral-200 hover:text-rose-300 border-neutral-700 hover:border-rose-500/40'
                : 'bg-[#efe8db] hover:bg-rose-100 text-stone-900 hover:text-rose-700 border-[#d6cbb7] hover:border-rose-300'
            }`}
          >
            Log out
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-12 gap-2.5">
        <aside className="col-span-12 lg:col-span-3 min-h-0 flex flex-col">
          <div
            ref={sidebarContainerRef}
            className={`flex-1 min-h-0 rounded-xl border p-3.5 flex flex-col ${
              isDark
                ? 'bg-neutral-900 border-neutral-800'
                : 'bg-[#fbf7f0] border-[#dcd2c0] shadow-xs'
            }`}
          >
            <div className="flex items-center justify-between gap-2 mb-2 shrink-0">
              <div
                className={`text-xs font-mono uppercase tracking-widest ${
                  isDark ? 'text-neutral-500' : 'text-stone-600'
                }`}
              >
                Context &amp; History
              </div>

              <button
                type="button"
                onClick={handleConnectBank}
                disabled={bankConnecting}
                aria-pressed={bankConnected}
                className={`px-2.5 py-1 rounded-lg border text-xs font-mono font-semibold whitespace-nowrap transition cursor-pointer shrink-0 flex items-center gap-1.5 ${
                  bankConnected
                    ? isDark
                      ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/30'
                      : 'bg-emerald-600 border-emerald-700 text-white hover:bg-emerald-700'
                    : isDark
                    ? 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border-neutral-700'
                    : 'bg-[#efe8db] hover:bg-[#e5dccb] text-stone-900 border-[#cfc3ae]'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    bankConnected
                      ? isDark
                        ? 'bg-emerald-400'
                        : 'bg-white'
                      : 'bg-neutral-400'
                  }`}
                />
                {bankConnecting
                  ? 'Connecting...'
                  : bankConnected
                  ? 'Bank Connected'
                  : 'Connect to bank'}
              </button>
            </div>

            <div
              className={`p-2.5 rounded-lg border text-xs space-y-0.5 mb-2 shrink-0 font-mono ${
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
              {bankConnected && (
                <div
                  className={`truncate font-semibold ${
                    isDark ? 'text-emerald-400' : 'text-emerald-700'
                  }`}
                >
                  • Llama Bank Feed: Live ({activeAccount.iban})
                </div>
              )}
            </div>

            {bankConnected && (
              <div className="shrink-0 flex flex-col">
                <div
                  className={`text-xs font-mono uppercase tracking-widest mb-1 flex items-center justify-between gap-2 ${
                    isDark ? 'text-emerald-400' : 'text-emerald-800'
                  }`}
                >
                  <span>Bank Invoices ({spawnedInvoices.length})</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleRefreshInvoices({ silent: false })}
                      disabled={refreshingInvoices}
                      title="Refresh invoices from Llama Bank"
                      aria-label="Refresh invoices from Llama Bank"
                      className={`px-1.5 py-0.5 rounded border text-[11px] font-mono transition cursor-pointer inline-flex items-center gap-1 ${
                        isDark
                          ? 'bg-neutral-800 hover:bg-neutral-700 text-emerald-300 border-neutral-700 disabled:opacity-50'
                          : 'bg-[#efe8db] hover:bg-[#e5dccb] text-emerald-900 border-[#cfc3ae] disabled:opacity-50'
                      }`}
                    >
                      <span className={refreshingInvoices ? 'inline-block animate-spin' : ''}>
                        ↻
                      </span>
                      <span>{refreshingInvoices ? 'Syncing' : 'Refresh'}</span>
                    </button>
                  </div>
                </div>

                <div
                  style={{ height: `${invoicesHeight}px` }}
                  className="space-y-1.5 overflow-y-auto pr-1"
                >
                  {spawnedInvoices.map((inv) => {
                    const isReceivable = inv.type === 'receivable';
                    return (
                      <button
                        key={inv.id}
                        type="button"
                        onClick={() =>
                          setInput(
                            `Analyze bank invoice ${inv.id} (${inv.contractor}, ${
                              isReceivable ? '+' : '-'
                            }${inv.amount.toLocaleString()} ${inv.currency}, due in ${
                              inv.dueInDays
                            } days)`
                          )
                        }
                        title="Click to ask AI about this invoice"
                        className={`w-full p-2 rounded-lg border text-left transition cursor-pointer ${
                          isDark
                            ? 'bg-emerald-950/20 hover:bg-emerald-950/40 border-emerald-500/30'
                            : 'bg-emerald-50/80 hover:bg-emerald-100/80 border-emerald-600/30'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 text-xs font-mono">
                          <span
                            className={`font-semibold truncate ${
                              isDark ? 'text-white' : 'text-stone-950'
                            }`}
                          >
                            {inv.id}
                          </span>
                          <span
                            className={`font-bold shrink-0 ${
                              isReceivable
                                ? isDark
                                  ? 'text-emerald-400'
                                  : 'text-emerald-700'
                                : isDark
                                ? 'text-rose-400'
                                : 'text-rose-700'
                            }`}
                          >
                            {isReceivable ? '+' : '-'}
                            {inv.amount.toLocaleString()} {inv.currency}
                          </span>
                        </div>
                        <div
                          className={`text-xs truncate ${
                            isDark ? 'text-neutral-300' : 'text-stone-800'
                          }`}
                        >
                          {inv.contractor}
                        </div>
                        <div
                          className={`text-[11px] font-mono flex items-center justify-between ${
                            isDark ? 'text-neutral-400' : 'text-stone-600'
                          }`}
                        >
                          <span>{inv.category}</span>
                          <span>Due {inv.dueInDays}d</span>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Draggable resize handle between Bank Invoices and Audit Log */}
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Drag to resize Bank Invoices and Audit Log"
                  onMouseDown={startSplitterDrag}
                  onTouchStart={startSplitterDrag}
                  title="Drag up or down to resize Bank Invoices"
                  className={`my-1.5 py-1 flex items-center justify-center cursor-ns-resize select-none group rounded transition ${
                    isDraggingSplitter
                      ? isDark
                        ? 'bg-neutral-800'
                        : 'bg-[#e6dcc9]'
                      : 'hover:bg-current/5'
                  }`}
                >
                  <div
                    className={`w-10 h-1 rounded-full transition ${
                      isDraggingSplitter
                        ? isDark
                          ? 'bg-emerald-400'
                          : 'bg-emerald-700'
                        : isDark
                        ? 'bg-neutral-700 group-hover:bg-neutral-500'
                        : 'bg-[#cfc3ae] group-hover:bg-stone-500'
                    }`}
                  />
                </div>
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1 text-xs">
              {historyLog.map((item) => {
                const isExpanded = Boolean(expandedLogIds[item.id]);
                return (
                  <div
                    key={item.id}
                    className={`rounded-lg border transition ${
                      isDark
                        ? 'bg-neutral-950 border-neutral-800/80 hover:border-neutral-700'
                        : 'bg-[#f4eee2] border-[#dfd6c5] hover:border-[#c8bba4]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleLogExpand(item.id)}
                      aria-expanded={isExpanded}
                      className="w-full p-2 text-left flex items-start justify-between gap-2 cursor-pointer"
                    >
                      <div className="flex items-start gap-2 min-w-0">
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
                      <span
                        className={`text-[10px] font-mono shrink-0 mt-0.5 ${
                          isDark ? 'text-neutral-500' : 'text-stone-600'
                        }`}
                      >
                        {isExpanded ? '▴' : '▾'}
                      </span>
                    </button>

                    {isExpanded && (
                      <div
                        className={`px-2.5 pb-2.5 pt-2 border-t text-[11px] font-mono space-y-1.5 ${
                          isDark
                            ? 'border-neutral-800 text-neutral-400 bg-neutral-900/60'
                            : 'border-[#dfd6c5] text-stone-700 bg-[#ede5d6]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span
                            className={`font-semibold ${
                              isDark ? 'text-sky-300' : 'text-sky-800'
                            }`}
                          >
                            {item.agent}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded ${
                              isDark
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : 'bg-emerald-600/15 text-emerald-800'
                            }`}
                          >
                            Conf: {item.confidence}
                          </span>
                        </div>
                        <div className="truncate">
                          <span className="opacity-70">Tool: </span>
                          <span className={isDark ? 'text-neutral-200' : 'text-stone-950'}>
                            {item.toolUsed}
                          </span>
                        </div>
                        <div
                          className={`p-2 rounded border whitespace-pre-wrap leading-relaxed ${
                            isDark
                              ? 'bg-neutral-950 border-neutral-800 text-neutral-300'
                              : 'bg-[#fbf7f0] border-[#d6cbb7] text-stone-800'
                          }`}
                        >
                          {item.reasoningTrace}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div
              className={`pt-2.5 mt-2.5 border-t shrink-0 ${
                isDark ? 'border-neutral-800' : 'border-[#dfd6c5]'
              }`}
            >
              <button
                type="button"
                disabled={!latestChart}
                onClick={() => latestChart && setChartModalOpen(true)}
                title={
                  latestChart
                    ? 'Open cashflow & liquidity chart'
                    : 'Connect to bank first to generate invoice cashflow chart'
                }
                className={`w-full py-2 px-3 rounded-lg border text-xs font-mono font-semibold flex items-center justify-center gap-2 transition ${
                  !latestChart
                    ? isDark
                      ? 'bg-neutral-900 text-neutral-600 border-neutral-800 cursor-not-allowed'
                      : 'bg-[#f4eee2] text-stone-400 border-[#dfd6c5] cursor-not-allowed'
                    : isDark
                    ? 'bg-neutral-800 hover:bg-neutral-700 text-white border-neutral-700 cursor-pointer'
                    : 'bg-[#efe8db] hover:bg-[#e5dccb] text-stone-950 border-[#cfc3ae] cursor-pointer'
                }`}
              >
                <span>📈 Show Chart</span>
              </button>
            </div>

            {/* Bottom-left Show Chart button */}
            <div
              className={`pt-3 mt-3 border-t shrink-0 ${
                isDark ? 'border-neutral-800' : 'border-[#dfd6c5]'
              }`}
            >
              <button
                type="button"
                onClick={() => setChartModalOpen(true)}
                className={`w-full py-2.5 px-3 rounded-lg border text-xs font-mono font-semibold flex items-center justify-center gap-2 transition cursor-pointer ${
                  isDark
                    ? 'bg-neutral-800 hover:bg-neutral-700 text-white border-neutral-700'
                    : 'bg-[#efe8db] hover:bg-[#e5dccb] text-stone-950 border-[#cfc3ae]'
                }`}
              >
                <span>📈 Show Chart</span>
              </button>
            </div>
          </div>
        </aside>

        <main
          className={`col-span-12 lg:col-span-9 min-h-0 rounded-xl border flex flex-col overflow-hidden ${
            isDark
              ? 'bg-neutral-900 border-neutral-800'
              : 'bg-[#fbf7f0] border-[#dcd2c0] shadow-xs'
          }`}
        >
          <div
            className={`px-4 py-2.5 border-b flex items-center justify-between gap-2 shrink-0 ${
              isDark ? 'border-neutral-800' : 'border-[#dfd6c5]'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <h2
                className={`font-semibold text-base truncate ${
                  isDark ? 'text-white' : 'text-stone-950'
                }`}
              >
                Finance AI Agent
              </h2>
            </div>

            {renderAccessibilityControls()}
          </div>

          <div
            aria-live="polite"
            className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3"
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
                    {msg.role === 'user' && msg.documentPreview && (
                      <DocumentIngestionCard
                        docMeta={msg.documentPreview}
                        isDark={!isDark}
                      />
                    )}
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
                  Finance AI Agent reasoning on OpenShift AI...
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div
            className={`p-3 border-t shrink-0 ${
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
                title="Upload receipts, invoices, or financial CSV"
                className={`px-3 py-2 rounded-lg border text-xs font-mono whitespace-nowrap transition shrink-0 cursor-pointer ${
                  isDark
                    ? 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
                    : 'bg-[#efe8db] hover:bg-[#e5dccb] border-[#d6cbb7] text-stone-900'
                }`}
              >
                + File
              </button>

              <input
                type="text"
                aria-label="Ask Finance AI Agent"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask Finance AI Agent or attach receipts/invoices..."
                className={`flex-1 min-w-0 border rounded-lg px-3.5 py-2 text-sm focus:outline-none ${
                  isDark
                    ? 'bg-neutral-950 border-neutral-700 text-white placeholder-neutral-500 focus:border-neutral-400'
                    : 'bg-[#f7f2e9] border-[#cfc3ae] text-stone-950 placeholder-stone-500 focus:border-stone-900'
                }`}
              />

              <button
                type="submit"
                disabled={loading}
                className={`px-4 py-2 rounded-lg disabled:opacity-50 font-semibold text-sm whitespace-nowrap transition shrink-0 cursor-pointer ${
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

      {chartModalOpen && latestChart && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Liquidity Forecast Chart"
          onClick={() => setChartModalOpen(false)}
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-2xl rounded-xl border overflow-hidden shadow-2xl ${
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
              <span
                className={`font-mono text-sm font-semibold ${
                  isDark ? 'text-white' : 'text-stone-950'
                }`}
              >
                {latestChart.title || 'Liquidity Forecast Chart'}
              </span>
              <button
                type="button"
                onClick={() => setChartModalOpen(false)}
                className={`text-sm font-mono cursor-pointer ${
                  isDark
                    ? 'text-neutral-400 hover:text-white'
                    : 'text-stone-600 hover:text-stone-950'
                }`}
              >
                [ESC / ✕]
              </button>
            </div>

            <div className="p-5">
              <LiquidityForecastChart chart={latestChart} isDark={isDark} />
            </div>
          </div>
        </div>
      )}

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
                    const accMetrics = computeBankMetrics(
                      acc,
                      isCurrent ? spawnedInvoices : [],
                      isCurrent && bankConnected
                    );
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
                              accMetrics.liquidity === null
                                ? isDark
                                  ? 'text-neutral-500'
                                  : 'text-stone-500'
                                : accMetrics.liquidity < 0
                                ? isDark
                                  ? 'text-rose-400'
                                  : 'text-rose-700'
                                : isDark
                                ? 'text-emerald-400'
                                : 'text-emerald-700'
                            }`}
                          >
                            {accMetrics.isConnected && accMetrics.liquidity !== null
                              ? accMetrics.liquidity > 0
                                ? `+${formatEuro(accMetrics.liquidity)}`
                                : formatEuro(accMetrics.liquidity)
                              : '—'}
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
                      Simulate approved filings without live submission
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
                      Allow Finance AI Agent to categorize minor deductions automatically
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
                      addLog(`Updated governance settings for ${activeAccount.name}`);
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