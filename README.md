# autonomous-cfo-collabothon
THE PROBLEM
What problem are you addressing? Who experiences it, and why is it important to solve?

Many small and medium business owners are not proficient in managing their finances to the full potential. Those businesses are very volatile and prone to sudden falling if not managed correctly.

YOUR SOLUTION
How does your project address this problem? Describe the core idea and what makes it unique, useful or innovative.

Our finance advisor provides constructive help without using jargon and the interface is adjustable for users to understand the topic fully and see the next steps clearly. The uniqueness of our product is displayed in Bank Connect - it reduces the fatigue of uploading invoices and makes every feature automated.

THE WORKING PROTOTYPE
What can users do with your project today? Walk us through the main features and distinguish what is already implemented and working.

The users can converse with ou AI Agent and get personalized financial suggestions based on their bank statements. The user is supplemented with a chart and a complete walkthrough. 

BEHIND THE BUILD
Explain how the key components work together and the technical decisions that shaped the implementation. Identify existing tools, libraries, services or codebases you built upon, and what your team created during the hackathon.

The React frontend sends user questions and uploaded files via multipart/form-data to the FastAPI backend, which deterministically extracts financial figures, blocks prompt-injection attempts, routes requests to the appropriate specialist Python agents (TaxAgent, LiquidityAgent, FXHedgingAgent), and passes only verified JSON metrics to the LLM with strict jargon-replacement rules.  

CHALLENGES AND DISCOVERIES
What challenges did you encounter? What approaches did you try, and what did you learn?

We found that a small 3B model can make math mistakes and fall for prompt-injection tricks like fake [ADMIN ACCESS] tags. Moving all calculations into Python and blocking jailbreaks with input/output guardrails made the assistant both accurate and safe. 

RESULTS AND NEXT STEPS
What did you achieve, and how did you validate or test it? Share the outcome you are most proud of, current limitations and what you would improve next.

We deployed a working prototype on Red Hat OpenShift AI that passes end-to-end financial and security tests. Next, we will plug in Bank Connect for live account balances and SEPA transactions, add database storage, and enable live Commerzbank execution.
