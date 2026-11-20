import React, { useState } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8081';

const INITIAL_PROPOSALS = [
  {
    id: 'liq-01',
    agent: 'Liquidity Agent',
    tag: 'Cash Flow Forecast (30-Day)',
    autonomousAnalysis: 'Detected a projected €82,000 working-capital dip on Day 22 due to quarterly VAT outflow overlapping with supplier invoice #INV-884.',
    recommendation: 'Activate €100,000 Commerzbank Flex-Credit Line for 14 days at 4.1% p.a. (Est. cost: €157).',
    businessLogic: 'Keeping a minimum €50,000 cash buffer avoids late-payment penalties (€1,250) and preserves early-payment supplier discounts (€1,800). Net savings: +€1,643.',
    governance: 'REQUIRES USER APPROVAL',
    executionMode: 'SIMULATED SANDBOX',
    status: 'pending',
    impact: '+€1,643 Net Benefit',
  },
  {
    id: 'fx-02',
    agent: 'FX Hedging Agent',
    tag: 'Currency Risk Alert',
    autonomousAnalysis: 'Identified $240,000 USD receivable due in 45 days. EUR/USD volatility increased by 1.8% this week.',
    recommendation: 'Lock in EUR/USD Forward Contract at 1.0840 via Commerzbank FX Desk.',
    businessLogic: 'Secures €221,402 guaranteed revenue and eliminates downside risk if USD weakens before invoice settlement.',
    governance: 'REQUIRES USER APPROVAL',
    executionMode: 'SIMULATED SANDBOX',
    status: 'pending',
    impact: '€221,402 Locked In',
  },
  {
    id: 'tax-03',
    agent: 'Tax Agent',
    tag: 'Advance Tax Optimization',
    autonomousAnalysis: 'Q3 operating profit is 11% lower than projected due to one-off equipment maintenance.',
    recommendation: 'Submit advance corporate tax adjustment request (-€14,500) before the 10th of next month.',
    businessLogic: 'Prevents overpaying tax installments now, keeping €14,500 in your operating account until annual reconciliation.',
    governance: 'REQUIRES USER APPROVAL',
    executionMode: 'SIMULATED SANDBOX',
    status: 'pending',
    impact: '+€14,500 Cash Retained',
  },
  {
    id: 'inv-04',
    agent: 'Investment Agent',
    tag: 'Idle Liquidity Sweep',
    autonomousAnalysis: '€180,000 has remained idle in your 0.1% checking account for 21 consecutive days above your safety threshold.',
    recommendation: 'Allocate €150,000 into Commerzbank 30-Day Money Market Term Deposit (3.45% p.a.).',
    businessLogic: 'Generates ~€425/month in low-risk interest while keeping €30,000 immediately accessible for daily operations.',
    governance: 'AUTO-MONITORED / APPROVAL NEEDED',
    executionMode: 'PERMITTED AFTER SIGN-OFF',
    status: 'pending',
    impact: '+€425 / mo Yield',
  },
];

export default function App() {
  const [selectedAgent, setSelectedAgent] = useState('All Agents');
  const [proposals, setProposals] = useState(INITIAL_PROPOSALS);
  const [auditLog, setAuditLog] = useState([
    { time: '09:14', text: 'Liquidity Agent scanned 3 Commerzbank SME accounts autonomously.' },
    { time: '09:15', text: 'FX Hedging Agent flagged $240,000 open USD invoice exposure.' },
  ]);
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: 'Welcome! I am your Autonomous CFO running on Red Hat OpenShift AI. Ask me to explain any recommendation in simple terms or test a "what-if" cash scenario.',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  const handleDecision = (id, decision) => {
    const target = proposals.find((p) => p.id === id);
    if (!target || target.status !== 'pending') return;

    setProposals((prev) =>
      prev.map((item) => (item.id === id ? { ...item, status: decision } : item))
    );

    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const actionLabel = decision === 'approved' ? 'APPROVED (Simulated Execution)' : 'DECLINED by Owner';
    setAuditLog((prev) => [
      { time: now, text: `${target.agent}: ${actionLabel} — ${target.tag}` },
      ...prev,
    ]);
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userPrompt = input.trim();
    setMessages((prev) => [...prev, { role: 'user', content: userPrompt }]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE_URL}/api/cfo/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userPrompt }),
      });
      if (!res.ok) throw new Error('Backend offline');
      const data = await res.json();
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
    } catch {
      // Built-in smart fallback when FastAPI backend isn't running yet
      const fallbackReply =
        userPrompt.toLowerCase().includes('credit') || userPrompt.toLowerCase().includes('liquidity')
          ? 'In simple terms: on Day 22 your VAT bill hits before your customer pays. Using the €100k credit line for 2 weeks costs €157, which saves you €1,643 in late fees and lost discounts. Nothing executes until you click Approve.'
          : 'Based on your current €342,500 cash balance and 30-day forecast, your business is healthy—approving the Liquidity and FX recommendations protects €221k in revenue and adds €1,643 in net cash savings.';
      setMessages((prev) => [...prev, { role: 'assistant', content: fallbackReply }]);
    } finally {
      setLoading(false);
    }
  };

  const filteredProposals =
    selectedAgent === 'All Agents'
      ? proposals
      : proposals.filter((p) => p.agent === selectedAgent);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Bar */}
      <header className="border-b border-slate-800 bg-slate-900/90 px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-400 text-slate-950 font-extrabold flex items-center justify-center text-sm shadow">
            CFO
          </div>
          <div>
            <h1 className="font-bold text-base tracking-tight">
              Autonomous CFO <span className="text-amber-400 font-normal">| SME Financial Copilot</span>
            </h1>
            <p className="text-xs text-slate-400">
              Plain-language financial decisions • Human-in-the-loop control
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs">
          <span className="px-3 py-1.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
            ● Red Hat OpenShift AI Connected
          </span>
          <span className="px-3 py-1.5 rounded-full bg-amber-400/10 text-amber-300 border border-amber-400/30">
            Sandbox Mode: User Approval Required
          </span>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 max-w-7xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 8 Columns: Financial Overview + Explainable Agent Proposals */}
        <div className="lg:col-span-8 space-y-6">
          {/* KPI Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
              <div className="text-xs text-slate-400">Available SME Liquidity</div>
              <div className="text-2xl font-bold mt-1">€342,500</div>
              <div className="text-xs text-emerald-400 mt-1">Monitored autonomously 24/7</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
              <div className="text-xs text-slate-400">30-Day Cash Forecast</div>
              <div className="text-2xl font-bold mt-1 text-amber-300">-€82,000 Dip (Day 22)</div>
              <div className="text-xs text-slate-400 mt-1">1 action ready for your review</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
              <div className="text-xs text-slate-400">Potential Value Identified</div>
              <div className="text-2xl font-bold mt-1 text-emerald-400">+€16,568</div>
              <div className="text-xs text-slate-400 mt-1">Across 4 specialized agents</div>
            </div>
          </div>

          {/* Agent Filter Tabs */}
          <div className="flex flex-wrap gap-2">
            {['All Agents', 'Liquidity Agent', 'FX Hedging Agent', 'Tax Agent', 'Investment Agent'].map(
              (agent) => (
                <button
                  key={agent}
                  onClick={() => setSelectedAgent(agent)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-medium transition ${
                    selectedAgent === agent
                      ? 'bg-amber-400 text-slate-950'
                      : 'bg-slate-900 text-slate-300 border border-slate-800 hover:border-slate-700'
                  }`}
                >
                  {agent}
                </button>
              )
            )}
          </div>

          {/* Explainable Agent Cards */}
          <div className="space-y-4">
            {filteredProposals.map((item) => (
              <div
                key={item.id}
                className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3"
              >
                {/* Card Header & Governance Badges */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-white">{item.agent}</span>
                    <span className="text-xs text-slate-400">• {item.tag}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium">
                    <span className="px-2.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30">
                      {item.governance}
                    </span>
                    <span className="px-2.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30">
                      {item.executionMode}
                    </span>
                  </div>
                </div>

                {/* Clear 3-Step Breakdown for Non-Technical Owners */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-800/80">
                    <div className="text-slate-400 font-semibold mb-1">1. Autonomous Analysis</div>
                    <p className="text-slate-300 leading-relaxed">{item.autonomousAnalysis}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-800/80">
                    <div className="text-amber-300 font-semibold mb-1">2. Recommended Action</div>
                    <p className="text-slate-200 leading-relaxed">{item.recommendation}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-800/80">
                    <div className="text-emerald-400 font-semibold mb-1">3. Why It Makes Sense</div>
                    <p className="text-slate-300 leading-relaxed">{item.businessLogic}</p>
                  </div>
                </div>

                {/* Owner Approval Bar */}
                <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/80">
                  <span className="text-xs font-semibold text-emerald-400">
                    Estimated Impact: {item.impact}
                  </span>

                  {item.status === 'pending' ? (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleDecision(item.id, 'rejected')}
                        className="px-3.5 py-1.5 rounded-lg text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                      >
                        Decline
                      </button>
                      <button
                        onClick={() => handleDecision(item.id, 'approved')}
                        className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition"
                      >
                        Approve & Simulate Execution
                      </button>
                    </div>
                  ) : (
                    <span
                      className={`text-xs font-semibold px-3 py-1 rounded-lg ${
                        item.status === 'approved'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                      }`}
                    >
                      {item.status === 'approved'
                        ? '✓ Approved by Owner (Simulated)'
                        : '✕ Declined by Owner'}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right 4 Columns: Interactive CFO Copilot + Governance Audit Trail */}
        <div className="lg:col-span-4 flex flex-col gap-6">
          {/* Chat Assistant */}
          <div className="rounded-xl bg-slate-900 border border-slate-800 flex flex-col h-[430px] overflow-hidden">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-sm">Ask Your CFO Copilot</h2>
                <p className="text-[11px] text-slate-400">Plain-language explanations for any decision</p>
              </div>
              <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                RHOAI LLM
              </span>
            </div>

            <div className="flex-1 p-4 space-y-3 overflow-y-auto text-xs">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`p-3 rounded-xl leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-amber-400 text-slate-950 font-medium ml-6'
                      : 'bg-slate-800 text-slate-200 mr-6'
                  }`}
                >
                  {m.content}
                </div>
              ))}
              {loading && (
                <div className="text-slate-400 animate-pulse">Analyzing financial data...</div>
              )}
            </div>

            <form onSubmit={sendMessage} className="p-3 border-t border-slate-800 flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask e.g. 'Explain the credit line'..."
                className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-amber-400"
              />
              <button
                type="submit"
                disabled={loading}
                className="px-3.5 py-2 rounded-lg bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs transition"
              >
                Ask
              </button>
            </form>
          </div>

          {/* Governance & Action Audit Log */}
          <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 space-y-3">
            <h3 className="font-semibold text-sm">Control & Audit Trail</h3>
            <p className="text-[11px] text-slate-400">
              Tracks autonomous checks vs. explicit owner approvals.
            </p>
            <div className="space-y-2 max-h-44 overflow-y-auto text-xs">
              {auditLog.map((entry, idx) => (
                <div
                  key={idx}
                  className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 flex gap-2"
                >
                  <span className="text-amber-400 font-mono">{entry.time}</span>
                  <span className="text-slate-300">{entry.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}