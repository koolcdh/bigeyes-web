// api/summarize.js — v0.7 final (i18n hard-enforce, contract domain, rebucket, core)
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ success: false, message: 'Missing OPENAI_API_KEY' });
    }

    const { imageBase64, lang = 'ko' } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ success: false, message: 'imageBase64 is required' });
    }

    const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

    const LABELS = {
      ko: {
        summary:'🧾 핵심요약', warnings:'⚠️ 주의', details:'🔎 세부정보',
        dose:'💊 복용법', ingredients:'📑 성분표',
        howto:'🛠️ 사용법', spec:'📐 사양',
        total:'💵 총액', items:'🧾 항목요약', payment:'💳 결제정보',
        intake:'🍽️ 섭취법', allergen:'🚫 알레르겐', nutrition:'📊 영양성분',
        features:'✨ 핵심특징', price:'💰 가격·조건',
        coreLabel:'📝 핵심요약', fallback:'간단 요약',
        // contract
        key_terms:'📌 핵심조건', cautions:'⚠️ 주의사항', contract_details:'🔎 세부조항',
        empty:'- 인식된 텍스트가 적습니다.\n- 사진을 더 가까이/밝게 촬영해 보세요.\n- 포커스를 맞춘 후 다시 시도하세요.',
      },
      en: {
        summary:'🧾 Summary', warnings:'⚠️ Warnings', details:'🔎 Details',
        dose:'💊 Dosage', ingredients:'📑 Ingredients',
        howto:'🛠️ How to use', spec:'📐 Specs',
        total:'💵 Total', items:'🧾 Items', payment:'💳 Payment',
        intake:'🍽️ How to take', allergen:'🚫 Allergens', nutrition:'📊 Nutrition',
        features:'✨ Key features', price:'💰 Price & terms',
        coreLabel:'📝 Summary', fallback:'Brief summary',
        // contract
        key_terms:'📌 Key terms', cautions:'⚠️ Cautions', contract_details:'🔎 Details',
        empty:'- Not enough readable text.\n- Try a closer/brighter photo.\n- Ensure focus, then retry.',
      },
      ja: {}, zh: {}
    };

    const DOMAINS = ['medicine','manual','receipt','food_label','product_page','contract','general'];
    const DOMAIN_TEMPLATES = {
      medicine:     ['dose','warnings','ingredients'],
      manual:       ['howto','warnings','spec'],
      receipt:      ['total','items','payment'],
      food_label:   ['intake','allergen','nutrition'],
      product_page: ['features','price','warnings'],
      contract:     ['key_terms','cautions','contract_details'],
      general:      ['summary','warnings','details'],
    };

    /* ---------- utils ---------- */
    const L = (lg) => LABELS[lg] || LABELS.ko;
    const normalizeSummary = (lg, s) => {
      const t = (s || '').trim();
      if (!t) return L(lg).empty;
      if (!t.includes('\n') && !t.startsWith('-')) return `- ${t}`;
      return t;
    };
    const splitBullets = (text='') =>
      text.split('\n').map(l => l.trim()).filter(Boolean).map(l => (l.startsWith('-') ? l.slice(1).trim() : l));
    const joinBullets = (arr) => (arr && arr.length) ? arr.map(b => `- ${b}`).join('\n') : '';
    const GENERIC_PATTERNS_KO = [/주의 필요/,/주의가 필요/,/주의 요함/,/일반적인 주의/,/안전상 주의/,/사용 전.*확인/,/상세.*참조/,/전문가.*상담/];
    const isGenericKo = (s) => GENERIC_PATTERNS_KO.some(r=>r.test(s));
    const sanitizeSummary = (lg, text) => {
      const kept = splitBullets(text).filter(b => b.length>1 && !isGenericKo(b));
      return kept.length ? joinBullets(kept) : L(lg).empty;
    };
    const allEmptySummaries = (lg, categories=[]) => {
      if (!categories.length) return true;
      return categories.every(c => {
        const t = String(c?.summary || '').trim();
        return !t || t === '-' || t === L(lg).empty || t.length < 3;
      });
    };
    const buildCoreFromCategories = (lg, categories=[]) => {
      const bullets=[];
      for(const c of categories){
        for(const b of splitBullets(c?.summary||'')){
          if(!isGenericKo(b) && b.length>1) bullets.push(b);
          if(bullets.length>=5) break;
        }
        if(bullets.length>=5) break;
      }
      if(!bullets.length) return L(lg).empty;
      const want = Math.min(5, Math.max(3, bullets.length));
      return joinBullets(bullets.slice(0, want));
    };

    /* ---------- prompts ---------- */
    const promptByLang = (lg='ko') => {
      const labels = L(lg);
      const titleMap = {
        medicine:     ['dose','warnings','ingredients'].map(k => ({ key:k, title:labels[k] || k })),
        manual:       ['howto','warnings','spec'].map(k => ({ key:k, title:labels[k] || k })),
        receipt:      ['total','items','payment'].map(k => ({ key:k, title:labels[k] || k })),
        food_label:   ['intake','allergen','nutrition'].map(k => ({ key:k, title:labels[k] || k })),
        product_page: ['features','price','warnings'].map(k => ({ key:k, title:labels[k] || k })),
        contract:     ['key_terms','cautions','contract_details'].map(k => ({ key:k, title:labels[k] || k })),
        general:      ['summary','warnings','details'].map(k => ({ key:k, title:labels[k] || k })),
      };

      const head = 'You read tiny printed labels and documents and summarize them concisely in a reporting tone.';
      const role = `
CATEGORY DEFINITIONS (examples):
- medicine: dose (when/how much/how often/time/age/with food), warnings (contra/interactions/side effects/storage/pregnancy/children), ingredients.
- receipt: total, items, payment.
- food_label: intake, allergens, nutrition.
- product_page: features, price, warnings.
- contract: key_terms (amount/period/subject/scope), cautions (exclusions/limitations/cancel-change), contract_details (other clauses/notes).
- general: summary, warnings, details.

GENERAL RULES:
- Detect domain from ["medicine","manual","receipt","food_label","product_page","contract","general"] and return ALL categories for that domain (no extra/missing, keep order).
- Each category must use 3–6 short '-' bullets, reporting tone, ONE fact per bullet.
- Emphasize key numbers/terms; avoid generic filler; no duplication; do not include category titles inside bullets.
- Provide "core_summary": 2–4 bullets TL;DR with brief advice.
- All JSON values (categories[].summary, core_summary) MUST be written in ${lg}. If the image text is another language, translate and STILL write in ${lg}.
- Output JSON only.
`;
      const titles = Object.entries(titleMap)
        .map(([d, arr]) => `- ${d}: [${arr.map(o => `{"key":"${o.key}","title":"${o.title}"}`).join(', ')}]`)
        .join('\n');

      return `${head}

${role}

OUTPUT JSON SHAPE:
{
  "domain": "<medicine|manual|receipt|food_label|product_page|contract|general>",
  "categories": [
    { "key": "<category key>", "title": "<localized title>", "summary": "<bulleted text in ${lg}>" }
  ],
  "core_summary": "<2-4 bullets TL;DR with brief advice in ${lg}>"
}

Localized titles per domain:
${titles}
`;
    };

    const repairPrompt = (lg='ko', domain='general', templateKeys=['summary','warnings','details']) => {
      const labels = L(lg);
      const titles = templateKeys.map(k => ({ key:k, title: labels[k] || k }));
      return `Your previous output had empty/misplaced summaries. REPAIR NOW.

Return JSON ONLY:
{
  "domain": "${domain}",
  "categories": [
    ${titles.map(t => `{ "key": "${t.key}", "title": "${t.title}", "summary": "" }`).join(',')}
  ],
  "core_summary": ""
}

Rules:
- Keep EXACTLY these category keys, in this order.
- Put ONLY relevant info into each category; 3–6 '-' bullets in ${lg}; no duplication.
- "core_summary": 2–4 bullets TL;DR with brief advice in ${lg}.`;
    };

    const rebucketPrompt = (lg='ko', domain='medicine', templateKeys=[], prevCategories=[]) => {
      return `Re-bucket the bullets strictly by definitions for domain "${domain}".
Keep EXACT category keys in this order: ${templateKeys.join(', ')}.
Move misplaced bullets to the correct category; remove generic filler. No duplication.
Output the same JSON shape (domain, categories[], core_summary).
Previous categories:
${JSON.stringify(prevCategories, null, 2)}
`;
    };

    /* ---------- OpenAI call ---------- */
    async function callOpenAIWithImage({ lg='ko', imageBase64, promptText }) {
      const body = {
        model: 'gpt-4o-mini',
        temperature: 0,
        top_p: 0.2,
        max_completion_tokens: 700,
        messages: [
          { role: 'system', content: 'You perform OCR-like reading and concise summarization with structured output.' },
          { role: 'user', content: [
              { type:'text', text: promptText },
              { type:'image_url', image_url: { url:`data:image/jpeg;base64,${imageBase64}` } }
            ]
          }
        ],
        response_format: { type:'json_object' }
      };
      const r = await fetch(OPENAI_URL, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify(body)
      });
      if (!r.ok) {
        const errText = await r.text().catch(()=> '');
        throw new Error(`OpenAI HTTP ${r.status} ${r.statusText} ${errText}`);
      }
      const data = await r.json();
      const raw = data?.choices?.[0]?.message?.content;
      let parsed = null; try { parsed = JSON.parse(raw); } catch {}
      return parsed;
    }

    // 간단 언어 힌트(ko 우선)
    const looksLikeKorean = (s='') => /[가-힣]/.test(s);
    const looksLikeEnglish = (s='') => /[A-Za-z]/.test(s);

    /* ---------- PIPELINE ---------- */
    // 1) 1차 추출
    let parsed = await callOpenAIWithImage({ lg: lang, imageBase64, promptText: promptByLang(lang) });

    // 1.5) 언어 불일치 시 1회 재시도 (특히 ko)
    if (lang === 'ko') {
      const sample = [
        parsed?.core_summary || '',
        ...(Array.isArray(parsed?.categories) ? parsed.categories.map(c=>c.summary||'').slice(0,2) : [])
      ].join('\n');

      const mismatch = !looksLikeKorean(sample) && looksLikeEnglish(sample);
      if (mismatch) {
        const enforce = `Your previous output used the wrong language. Rewrite the SAME JSON in Korean (ko) ONLY. Translate any content if needed. Do not change structure or meaning. Output JSON only.`;
        const retry = await callOpenAIWithImage({ lg: lang, imageBase64, promptText: enforce });
        if (retry?.categories?.length) parsed = retry;
      }
    }

    let domain = DOMAINS.includes(parsed?.domain) ? parsed.domain : 'general';
    const templateKeys = DOMAIN_TEMPLATES[domain];

    let categories = Array.isArray(parsed?.categories) ? parsed.categories : [];
    categories = categories
      .filter(c => templateKeys.includes(c.key))
      .map(c => ({
        key: c.key,
        title: L(lang)[c.key] || c.title || c.key,
        summary: sanitizeSummary(lang, normalizeSummary(lang, String(c.summary || '').trim()))
      }));

    // 템플릿 보장
    if (!categories.length) {
      categories = templateKeys.map(k => ({ key:k, title: L(lang)[k] || k, summary: L(lang).empty }));
    }
    const exist = new Set(categories.map(c=>c.key));
    for (const k of templateKeys) {
      if (!exist.has(k)) categories.push({ key:k, title:L(lang)[k]||k, summary:L(lang).empty });
    }

    // 2) Re-bucket
    const rebucket = await callOpenAIWithImage({
      lg: lang, imageBase64, promptText: rebucketPrompt(lang, domain, templateKeys, categories)
    });
    if (Array.isArray(rebucket?.categories) && rebucket.categories.length) {
      let fixed = rebucket.categories
        .filter(c => templateKeys.includes(c.key))
        .map(c => ({
          key: c.key,
          title: L(lang)[c.key] || c.title || c.key,
          summary: sanitizeSummary(lang, normalizeSummary(lang, String(c.summary||'').trim()))
        }));
      const ex2 = new Set(fixed.map(c=>c.key));
      for (const k of templateKeys) {
        if (!ex2.has(k)) fixed.push({ key:k, title:L(lang)[k]||k, summary:L(lang).empty });
      }
      categories = fixed;
    }

    // 3) 핵심요약
    let core = String(parsed?.core_summary || '').trim();
    if (!core) core = buildCoreFromCategories(lang, categories);
    core = sanitizeSummary(lang, normalizeSummary(lang, core));

    // 4) 전부 비었으면 마지막 보정
    if (allEmptySummaries(lang, categories)) {
      const repaired = await callOpenAIWithImage({
        lg: lang, imageBase64, promptText: repairPrompt(lang, domain, templateKeys)
      });
      let repairedCats = Array.isArray(repaired?.categories) ? repaired.categories : [];
      repairedCats = repairedCats
        .filter(c => templateKeys.includes(c.key))
        .map(c => ({
          key: c.key,
          title: L(lang)[c.key] || c.title || c.key,
          summary: sanitizeSummary(lang, normalizeSummary(lang, c.summary))
        }));
      if (repairedCats.length) categories = repairedCats;
      if (!core || core === L(lang).empty) core = buildCoreFromCategories(lang, categories);
    }

    const payload = { domain, categories, coreSummary: core };
    return res.json({ success: true, payload });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ success:false, message: e.message });
  }
}
