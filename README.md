# autonomous-cfo-collabothon
PROJECT NAME

FinancAI.lly

ONE LINE SUMMARY

User-friendly financial advisor for all generations targeted towards small to medium businesses.

TECHNOLOGY STACK

Python, JavaScript, FastAPI, Red Hat OpenShift AI, llama-32-3b-instruct, NVIDIA GPU

THE PROBLEM

Many small and medium business owners are not proficient in managing their finances to the full potential. Those businesses are very volatile and prone to sudden falling if not managed correctly.


YOUR SOLUTION

Our finance advisor provides constructive help without using jargon and the interface is adjustable for users to understand the topic fully and see the next steps clearly. The uniqueness of our product is displayed in Bank Connect - it reduces the fatigue of uploading invoices and makes every feature automated.


THE WORKING PROTOTYPE

The users can converse with ou AI Agent and get personalized financial suggestions based on their bank statements. The user is supplemented with a chart and a complete walkthrough. 


BEHIND THE BUILD

The React frontend sends user questions and uploaded files via multipart/form-data to the FastAPI backend, which deterministically extracts financial figures, blocks prompt-injection attempts, routes requests to the appropriate specialist Python agents (TaxAgent, LiquidityAgent, FXHedgingAgent), and passes only verified JSON metrics to the LLM with strict jargon-replacement rules.  


CHALLENGES AND DISCOVERIES

We found that a small 3B model can make math mistakes and fall for prompt-injection tricks like fake [ADMIN ACCESS] tags. Moving all calculations into Python and blocking jailbreaks with input/output guardrails made the assistant both accurate and safe. 


RESULTS AND NEXT STEPS

We deployed a working prototype on Red Hat OpenShift AI that passes end-to-end financial and security tests. Next, we will plug in Bank Connect for live account balances and SEPA transactions, add database storage, and enable live Commerzbank execution.
