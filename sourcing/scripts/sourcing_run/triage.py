"""Narrow 1825 extracted 'companies' to a reviewable candidate pool.

This is a pre-filter for human review, NOT a scorer. It only removes rows that
are provably not investable European seed/Series A companies (regulators, VCs,
media, tokens, laws, incumbents, generic nouns). Everything surviving goes to
manual review.
"""
from __future__ import annotations

import csv
import re
import sys

ROW = tuple[str, str, str, str, str, str, str]

# --- Hard exclusions: not a company at all, or structurally out of thesis ---

INCUMBENT = {
    # mega-cap / big tech / public
    "anthropic", "openai", "google", "alphabet", "meta", "amazon", "aws", "amazon web services",
    "microsoft", "microsoft 365", "apple", "nvidia", "advanced micro devices", "amd", "intel",
    "broadcom", "tsmc", "micron", "seagate", "marvell", "oracle", "sap", "ibm", "salesforce",
    "servicenow", "snowflake", "databricks", "cloudflare", "dropbox", "box", "asana", "notion",
    "slack", "linkedin", "youtube", "canva", "figma", "atlassian", "hubspot", "docusign",
    "quickbooks", "spacex", "tesla", "waymo", "uber", "doordash", "shopify", "palantir", "xai",
    "grok", "perplexity", "mistral", "deepseek", "cursor", "anysphere", "replit", "lovable",
    "groq", "coreweave", "crusoe", "sentry", "supabase", "langchain", "openrouter", "harvey",
    "elevenlabs", "telegram", "signal", "sony", "samsung", "huawei", "alibaba", "tencent",
    "bytedance", "baidu", "xiaomi", "byd", "toyota", "hyundai", "netease", "jd.com", "meituan",
    "taobao", "tmall", "wechat", "alipay", "rakuten", "softbank", "disney", "walmart", "target",
    "etsy", "wayfair", "peloton", "whoop", "oura", "myfitnesspal", "h&m", "electrolux",
    "deliveroo", "mrbeast", "spotify", "klarna", "revolut", "revolut bank", "monzo", "starling",
    "starling bank", "n26", "bunq", "wise", "wise bank", "adyen", "stripe", "paypal", "block",
    "square", "affirm", "marqeta", "brex", "ramp", "mercury", "plaid", "truelayer", "gocardless",
    "worldpay", "fiserv", "fis", "global payments", "nuvei", "payoneer", "rapyd", "airwallex",
    "checkout.com", "sofi", "nubank", "robinhood", "etoro", "avanza", "nordnet", "wealthsimple",
    "betterment", "upstart", "lendingclub", "bill.com", "capital one", "deel", "rippling",
    "visa", "mastercard", "amex", "swift", "nets", "worldline", "ingenico", "sinch", "truecaller",
    "coinbase", "binance", "kraken", "okx", "bybit", "bitget", "htx", "crypto.com", "gemini",
    "bitfinex", "bitmex", "deribit", "bitpanda", "blockchain.com", "moonpay", "consensys",
    "ledger", "trezor", "metamask", "phantom", "bitstamp", "circle", "tether", "ripple",
    "ripple labs", "paxos", "fireblocks", "bitgo", "anchorage", "chainalysis", "elliptic",
    "trm", "trm labs", "securitize", "bvnk", "wirex", "nexo", "galaxy", "wintermute", "b2c2",
    "cumberland", "falconx", "keyrock", "microstrategy", "strategy", "blackrock", "fidelity",
    "vanguard", "schroders", "invesco", "grayscale", "21shares", "bitwise", "vaneck",
    "wisdomtree", "janus henderson investors", "apollo", "blackstone", "brookfield", "tpg",
    "bain capital", "kkr", "goldman", "citi", "citigroup", "jpmorgan", "j.p. morgan payments",
    "kinexys", "hsbc", "barclays", "deutsche bank", "ubs", "santander", "bbva", "seb", "swedbank",
    "nordea", "dnb", "ing", "lloyds", "halifax", "bank of america", "bny", "state street",
    "northern trust", "dtcc", "clearstream", "euroclear", "nasdaq", "nyse", "ice", "cme",
    "tradeweb", "broadridge", "moody's", "s&p", "factset", "pitchbook", "crunchbase", "dealogic",
    "dun & bradstreet", "accenture", "mckinsey", "bcg", "boston consulting group", "kpmg",
    "deloitte", "ey", "pwc", "gartner", "freshfields", "sullivan & cromwell", "carta",
    "angellist", "yc", "northvolt", "voi", "vinted", "kry", "blocket", "saab", "helsing",
    "anduril", "iceye", "solana", "ethereum", "bitcoin", "cardano", "polkadot", "avalanche",
    "polygon", "polygon labs", "arbitrum", "optimism", "base", "near", "near protocol", "sui",
    "aptos", "celestia", "monad", "tron", "stellar", "hedera", "filecoin", "zcash", "litecoin",
    "chainlink", "chainlink labs", "uniswap", "aave", "aave labs", "compound", "maker",
    "makerdao", "lido", "lido finance", "curve finance", "1inch", "pendle", "ethena",
    "ethena labs", "morpho", "hyperliquid", "dydx", "gmx", "jito", "raydium", "jupiter",
    "meteora", "orca", "pump.fun", "opensea", "starkware", "zksync", "matter labs", "scroll",
    "linea", "taiko", "mysten labs", "aztec", "aztec labs", "nethermind", "openzeppelin",
    "certik", "alchemy", "quicknode", "helius", "infura", "thirdweb", "wormhole", "layerzero",
    "layerzero opcodes", "stargate", "centrifuge", "centrifuge labs", "maple", "maple finance",
    "ondo", "ondo finance", "superstate", "backed finance", "worldcoin", "world", "tempo",
    "kalshi", "polymarket", "lightspark", "blockstream", "tangem", "zengo", "sygnum bank",
    "relai", "coinmotion", "bitpin", "nobitex", "wallex", "ramzinex", "amlbot", "unit21",
    "castellum.ai", "blockaid", "peckshield", "certora", "zama", "aiia", "minna technologies",
    "3s money", "legora", "yubico", "kivra", "bankid", "freja eid", "swiftcourt", "gilion",
    "fortnox", "visma", "sinch", "lemfi", "chippercash", "synctera", "dinari", "tzero group",
    "figure technology solutions", "wonderfi", "wonderfi technologies", "coinsquare", "bitbuy",
    "bakkt", "erebor", "obex", "thunes", "convera", "dlocal", "ebanx", "pricerunner", "pony.ai",
}

INVESTOR_HINT = re.compile(
    r"\b(ventures?|capital|partners|fund(s| i{1,3}| \d)?|vc|angel|accelerator|incubator|"
    r"investments?|holdings?|equity|asset management|advisors?)\b", re.I)
INVESTOR_EXACT = {
    "a16z", "a16z crypto", "andreessen horowitz speedrun", "sequoia", "sequoia capital",
    "benchmark", "index ventures", "accel", "balderton", "balderton capital", "northzone",
    "creandum", "atomico", "lakestar", "seedcamp", "antler", "kinnevik", "eqt", "eqt ventures",
    "cherry", "earlybird", "anthemis", "fabric ventures", "hoxton", "albionvc", "outlier",
    "paradigm", "multicoin", "multicoin capital", "pantera", "framework ventures", "electric capital",
    "coinfund", "haun ventures", "coatue", "thrive capital", "greenoaks", "dragoneer",
    "altimeter capital", "ribbit", "ribbit capital", "valar ventures", "craft ventures",
    "battery ventures", "lightspeed", "lightspeed venture partners", "blueyard capital",
    "felix capital", "passion capital", "inventure", "cyberstarts", "tusk ventures", "volt capital",
    "rockawayx", "yzi labs", "generative ventures", "signature ventures", "adara ventures",
    "tritemius", "tritemius ventures s.l.", "tritemius fund i", "tritemius emerging technologies",
    "mubadala", "mubadala capital", "omers ventures", "20vc", "stride.vc", "quantumlight",
    "butterfly ventures", "wellstreet", "sting", "nato innovation fund", "eif", "invest-nl",
    "coinbase ventures", "circle ventures", "arbitrum ventures", "nfa", "sbi", "foundry",
}

REGULATOR = {
    "sec", "cftc", "fca", "bafin", "finma", "esma", "eba", "ecb", "bis", "imf", "oecd", "occ",
    "fdic", "finra", "fincen", "ofac", "cfpb", "ftc", "asic", "mas", "hkma", "pra", "amla",
    "cnmv", "cnv", "afm", "amf", "consob", "finansinspektionen", "riksbanken", "riksbank",
    "lietuvos bankas", "bank of england", "bank of canada", "bank of korea", "bank of latvia",
    "banco de españa", "swiss national bank", "european central bank", "financial conduct authority",
    "financial conduct authority (fca)", "autoriteit financiële markten", "hong kong monetary authority",
    "monetary authority of singapore", "prudential regulation authority",
    "office of the comptroller of the currency", "office of the comptroller of the currency (occ)",
    "commodity futures trading commission", "commodity futures trading commission (cftc)",
    "u.s. securities and exchange commission", "anti-money laundering authority",
    "malta financial services authority", "cyprus securities and exchange commission",
    "hellenic capital market commission", "commission de surveillance du secteur financier",
    "canadian investment regulatory organization", "japan financial services agency",
    "financial services agency", "european data protection board", "bank for international settlements",
    "international monetary fund", "international monetary fund (imf)", "eurosystem",
    "financial action task force", "fatf", "europol", "interpol", "fbi", "cia", "doj", "irs",
    "irs-ci", "ncsc", "national cyber security centre", "senate", "congress", "treasury",
    "u.s. treasury department", "senate banking committee", "u.s. senate banking committee",
    "house financial services committee", "ekobrottsmyndigheten", "skatteverket", "bolagsverket",
    "energimyndigheten", "transportstyrelsen", "rymdstyrelsen", "regeringen", "sveriges stat",
    "swedish government", "finland government", "government of brazil", "trump administration",
    "white house council of economic advisers", "u.s. commerce department",
    "u.s. department of justice", "new york attorney general letitia james", "congressional research service",
    "division of trading and markets", "sec crypto task force", "u.k. regulator", "apac regulators",
    "law enforcement", "u.s. law enforcement", "the clearing house", "fedwire",
}

MEDIA_OR_EVENT = re.compile(
    r"(week$|weekly|forum|summit|conference|awards?$|podcast|newsletter|magazine|times$|"
    r"journal$|report$|review$|news$|blueprint|association|foundation|institute|university|"
    r"school|college|högskolan|universit|academy|dao$|committee|council|alliance|chamber|"
    r"initiative|program(me)?$|fellowship|20/20|money20)", re.I)
MEDIA_EXACT = {
    "forbes", "axios", "bloomberg", "wsj", "the wall street journal", "wall street journal",
    "new york times", "marketwatch", "fortune", "breakit", "dagens industri", "bankless",
    "blockworks", "messari", "defillama", "coingecko", "rwa.xyz", "rwaxyz", "l2beat",
    "the defiant", "the block", "the fintech blueprint", "fintech business weekly",
    "this week in fintech", "week in ethereum news", "the defi report", "dune", "nansen",
    "kyivstoner", "di investor relations", "the harris poll", "s&p global ratings",
    "s&p dow jones indices", "s&p 500", "russell 1000", "bitcointreasuries.net",
}

# Tokens, tickers, chains, standards, laws, protocols, models, generic nouns
NOT_A_COMPANY = re.compile(
    r"^(erc|eip|bip|hip|h\.r\.|sb |cer-|nis\d|psd\d|mica|dora|gdpr|eidas|fatf|aml|kyc|kyb|"
    r"crs|ucp|acp|mcp|api|ai$|defi$|tradfi$|rwas?$|nft|dlt|tvl|hsm|mpc|zk)", re.I)
TICKER = re.compile(r"^[\$]?[A-Z0-9₮\.]{2,6}$")
MODEL = re.compile(r"(claude|gpt|chatgpt|gemma|gemini|qwen|kimi|grok|llama|opus|sonnet|haiku|"
                   r"fable|mythos|deepseek|minimax|z\.ai|zhipu|copilot|siri|alexa)", re.I)
GENERIC = re.compile(
    r"^(banks?|fintechs?|crypto|crypto exchanges|stablecoins?|stablecoin issuers|vaults?|"
    r"broker-dealers|prime brokers|money market funds|tokenized \w+|onchain finance|ai agents|"
    r"tech sector|bigtech|l2s|rpc nodes|regtech startups|virtual asset service providers|"
    r"retail vasps|european banks|eur stablecoins|uk financial institutions|wall street banks|"
    r"defi front-ends|payments network|\d+ companies|limited|new|real|lead|studio|ny|x|"
    r"foundation|engine|signal|snapshot|story|current|verified|extended|platform team|"
    r"app relations team|protocol support team|protocol track leads|ecosystem support program.*|"
    r"eth labs|ethereum core devs|ethereum core contributors|apac|us|uk|eu|sverige|"
    r"[a-z]{1,3})$", re.I)
COUNTRY_OR_PLACE = {
    "ukraine", "russia", "iran", "brazil", "greece", "malta", "latvia", "lithuania", "luxembourg",
    "singapore", "denmark", "london", "hangzhou", "arizona", "nevada", "oregon", "illinois",
    "wisconsin", "kentucky", "alabama", "wyoming", "massachusetts", "strait of hormuz", "eea",
    "apac", "japan", "south korea", "india", "china", "taiwan",
}

# --- Positive thesis signal in the description ---
THESIS = re.compile(
    r"\b(tokenis|tokeniz|custody|custodian|wallet|key management|mpc|multi-party|hsm|"
    r"settlement|clearing|post-trade|identity|eidas|verifiable credential|did\b|kyc|kyb|aml|"
    r"sanctions|compliance|regtech|travel rule|mica|casp|emi\b|payment institution|licence|"
    r"license|sandbox|infrastructure|rails|middleware|interoperab|cross-chain|oracle|"
    r"attestation|proof|zero-knowledge|zk\b|smart contract|api|sdk|institution|bank|"
    r"asset manager|exchange|stablecoin|digital asset|rwa|real-world asset|treasury|"
    r"securities|fund admin|transfer agent|deposit|e-money|iban|acquiring|issuing)\b", re.I)
EUROPE = re.compile(
    r"\b(europe|european|eu\b|uk\b|british|london|germany|german|berlin|munich|france|french|"
    r"paris|switzerland|swiss|zurich|zug|geneva|netherlands|dutch|amsterdam|sweden|swedish|"
    r"stockholm|norway|norwegian|oslo|denmark|danish|copenhagen|finland|finnish|helsinki|"
    r"spain|spanish|madrid|barcelona|italy|italian|milan|ireland|irish|dublin|estonia|"
    r"lithuania|latvia|poland|polish|warsaw|portugal|lisbon|austria|vienna|belgium|brussels|"
    r"luxembourg|liechtenstein|malta|nordic|dach|mica|bafin|finma|fca|esma|amf|consob|cnmv|"
    r"finansinspektionen)\b", re.I)

EARLY = re.compile(r"\b(seed|series a|pre-seed|early-stage|founded in 20(1[4-9]|2\d)|launch|"
                   r"raised (€|\$|£)?\d{1,2}(\.\d)?\s?(m|million)|startup)\b", re.I)
LATE = re.compile(r"\b(series [c-g]\b|ipo|public(ly traded)?|nasdaq-listed|acquired by|"
                  r"unicorn|valuation of (€|\$|£)?\d+\s?(b|billion)|raised (€|\$|£)?\d{3,}\s?(m|million)|"
                  r"raised (€|\$|£)?\d+\s?(b|billion))", re.I)


def classify(name: str, desc: str, people: set[str]) -> tuple[str, str]:
    n = name.strip()
    low = n.lower()

    if low in people:
        return "excluded", "person"
    if low in INCUMBENT:
        return "excluded", "incumbent/too-late"
    if low in INVESTOR_EXACT:
        return "excluded", "investor"
    if low in REGULATOR:
        return "excluded", "regulator/government"
    if low in MEDIA_EXACT:
        return "excluded", "media/data-provider"
    if low in COUNTRY_OR_PLACE:
        return "excluded", "place"
    if GENERIC.match(n):
        return "excluded", "generic-noun"
    if NOT_A_COMPANY.match(n):
        return "excluded", "standard/law/concept"
    if MODEL.search(n):
        return "excluded", "ai-model/product"
    if MEDIA_OR_EVENT.search(n):
        return "excluded", "media/event/institution"
    if INVESTOR_HINT.search(n) and not THESIS.search(desc):
        return "excluded", "investor-like"
    if TICKER.match(n):
        return "excluded", "ticker/acronym"
    if len(n.split()) >= 2 and n.split()[0] in people_first_names:
        return "excluded", "person-like"
    if LATE.search(desc) and not EARLY.search(desc):
        return "excluded", "late-stage-signal"
    if not THESIS.search(desc):
        return "excluded", "no-thesis-signal"
    return "candidate", "europe" if EUROPE.search(desc) or EUROPE.search(n) else "geo-unknown"


people_first_names: set[str] = set()

if __name__ == "__main__":
    people = set()
    with open("people.txt", encoding="utf-8") as fh:
        for line in fh:
            nm = line.strip().lower()
            if nm:
                people.add(nm)
                people_first_names.add(nm.split()[0].title())

    rows = []
    with open("all_1825.tsv", encoding="utf-8") as fh:
        for parts in csv.reader(fh, delimiter="\t"):
            if len(parts) < 7:
                parts += [""] * (7 - len(parts))
            rows.append(parts)

    buckets: dict[str, list] = {}
    candidates = []
    for eid, score, fc, sc, name, url, desc in rows:
        verdict, reason = classify(name, desc, people)
        buckets.setdefault(reason if verdict == "excluded" else f"CANDIDATE/{reason}", []).append(name)
        if verdict == "candidate":
            candidates.append((eid, float(score or 0), int(fc or 0), int(sc or 0), name, url, desc, reason))

    print("=== exclusion breakdown ===")
    for reason, names in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
        print(f"{len(names):>5}  {reason}")

    candidates.sort(key=lambda r: (r[7] == "europe", r[1]), reverse=True)
    with open("candidates.tsv", "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, delimiter="\t")
        for c in candidates:
            w.writerow(c)
    print(f"\ncandidates written: {len(candidates)}", file=sys.stderr)
