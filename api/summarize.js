// api/summarize.js — final (+coupang_query, +guessSummary)
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ success: false, message: 'Missing OPENAI_API_KEY' });
    }

    const { imageBase64, lang = 'ko', forceModel = '' } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ success: false, message: 'imageBase64 is required' });
    }

    const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

    // --------- i18n labels ---------
    const LABELS = {
      ko: {
        summary:'🧾 핵심요약', warnings:'⚠️ 주의', details:'🔎 세부정보',
        dose:'💊 복용법', ingredients:'📑 성분표',
        howto:'🛠️ 사용법', spec:'📐 사양',
        total:'💵 총액', items:'🧾 항목요약', payment:'💳 결제정보',
        intake:'🍽️ 섭취법', allergen:'🚫 알레르겐', nutrition:'📊 영양성분',
        features:'✨ 핵심특징', price:'💰 가격·조건',
        // Contract
        parties:'👥 당사자/역할', keyterms:'📌 핵심조항', obligations:'🧭 의무/범위',
        dates:'🗓️ 기간/해지', fees:'💰 금액/지급', risks:'⚠️ 유의/리스크',

        coreLabel:'📝 핵심요약', fallback:'간단 요약',
        empty:'- 인식된 텍스트가 적습니다.\n- 사진을 더 가까이/밝게 촬영해 보세요.\n- 포커스를 맞춘 후 다시 시도하세요.',
      },
      en: {
        summary:'🧾 Summary', warnings:'⚠️ Warnings', details:'🔎 Details',
        dose:'💊 Dosage', ingredients:'📑 Ingredients',
        howto:'🛠️ How to use', spec:'📐 Specs',
        total:'💵 Total', items:'🧾 Items', payment:'💳 Payment',
        intake:'🍽️ How to take', allergen:'🚫 Allergens', nutrition:'📊 Nutrition',
        features:'✨ Key features', price:'💰 Price & terms',
        // Contract
        parties:'👥 Parties/Roles', keyterms:'📌 Key Terms', obligations:'🧭 Obligations/Scope',
        dates:'🗓️ Term/Termination', fees:'💰 Fees/Payment', risks:'⚠️ Notes/Risks',

        coreLabel:'📝 Summary', fallback:'Brief summary',
        empty:'- Not enough readable text.\n- Try a closer/brighter photo.\n- Ensure focus, then retry.',
      },
    };

    const DOMAINS = ['medicine','manual','receipt','food_label','product_page','contract','general'];
    const DOMAIN_TEMPLATES = {
      medicine:     ['dose','warnings','ingredients'],
      manual:       ['howto','warnings','spec'],
      receipt:      ['total','items','payment'],
      food_label:   ['intake','allergen','nutrition'],
      product_page: ['features','price','warnings'],
      contract:     ['parties','keyterms','obligations','dates','fees','risks'],
      general:      ['summary','warnings','details'],
    };

    // --------- utils ---------
    const L = (lg) => LABELS[lg] || LABELS.ko;
    const normalizeSummary = (lg, s='') => {
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

    // --------- prompts ---------
    const promptByLang = (lg='ko') => {
      const labels = L(lg);
      const titleMap = {
        medicine:     ['dose','warnings','ingredients'].map(k => ({ key:k, title:labels[k] || k })),
        manual:       ['howto','warnings','spec'].map(k => ({ key:k, title:labels[k] || k })),
        receipt:      ['total','items','payment'].map(k => ({ key:k, title:labels[k] || k })),
        food_label:   ['intake','allergen','nutrition'].map(k => ({ key:k, title:labels[k] || k })),
        product_page: ['features','price','warnings'].map(k => ({ key:k, title:labels[k] || k })),
        contract:     ['parties','keyterms','obligations','dates','fees','risks'].map(k => ({ key:k, title:labels[k] || k })),
        general:      ['summary','warnings','details'].map(k => ({ key:k, title:labels[k] || k })),
      };

      const head = 'You read tiny printed labels or documents and summarize them concisely.';
      const role = `
CATEGORY DEFINITIONS (examples):
- medicine: dose / warnings / ingredients
- manual: howto / warnings / spec
- receipt: total / items / payment
- food_label: intake / allergen / nutrition
- product_page: features / price / warnings
- contract: parties / keyterms / obligations / dates / fees / risks

GENERAL RULES:
- Choose one domain from ${JSON.stringify(DOMAINS)}.
- Return ALL categories for the chosen domain (no extra/missing, keep order).
- Each category must contain ONLY relevant info; 3–6 bullets, '-' marker, no duplication.
- Keep a factual, "reporting to user" tone: short bullet points.
- If info is scarce, keep it minimal; do NOT fabricate.
- Add "core_summary": 2–4 bullets TL;DR with brief GPT advice. Write in ${lg}.
- Add "coupang_query": one search keyword line (<=80 chars, in ${lg}). Compose from brand/product/model/size; EXCLUDE price/discount words; avoid punctuation noise.
- Output JSON only.`;

      const titles = Object.entries(titleMap)
        .map(([d, arr]) => `- ${d}: [${arr.map(o => `{"key":"${o.key}","title":"${o.title}"}`).join(', ')}]`)
        .join('\n');

      return `${head}

${role}

OUTPUT JSON SHAPE:
{
  "domain": "<${DOMAINS.join('|')}>",
  "categories": [
    { "key": "<category key>", "title": "<localized title>", "summary": "<bulleted text in ${lg}>" }
  ],
  "core_summary": "<2-4 bullets TL;DR with brief GPT advice in ${lg}>",
  "coupang_query": "<string>"
}

Localized titles per domain:
${titles}`;
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
  "core_summary": "",
  "coupang_query": ""
}

Rules:
- Keep EXACTLY these category keys, in this order.
- Put ONLY relevant info into each category; 3–6 '-' bullets in ${lg}; no duplication.
- "core_summary": 2–4 bullets TL;DR in ${lg}.
- "coupang_query": one line keyword as defined.`;
    };

    const rebucketPrompt = (lg='ko', domain='general', templateKeys=[], prevCategories=[]) => {
      return `Re-bucket the bullets strictly by definitions for domain "${domain}".
Keep EXACT category keys in this order: ${templateKeys.join(', ')}.
Move misplaced bullets to the correct category; remove generic filler. No duplication.
Output the same JSON shape (domain, categories[], core_summary, coupang_query).
Previous categories:
${JSON.stringify(prevCategories, null, 2)}
`;
    };

    // --------- OpenAI call ---------
    async function callOpenAIWithImage({ model, lg='ko', imageBase64, promptText }) {
      const body = {
        model,
        temperature: 0,
        top_p: 0.2,
        max_completion_tokens: 900,
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

    // --------- one-round inference pipeline ---------
    async function runOnce(modelName) {
      // 1) 1차 추출
      let parsed = await callOpenAIWithImage({ model: modelName, lg: lang, imageBase64, promptText: promptByLang(lang) });
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
        model: modelName, lg: lang, imageBase64, promptText: rebucketPrompt(lang, domain, templateKeys, categories)
      }).catch(() => null);
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

      // 3) 핵심요약 + 추천검색어
      let core = String(parsed?.core_summary || '').trim();
      if (!core) core = buildCoreFromCategories(lang, categories);
      core = sanitizeSummary(lang, normalizeSummary(lang, core));
      const coupangQuery = String(parsed?.coupang_query || '').trim();

      // 4) 마지막 보정
      if (allEmptySummaries(lang, categories)) {
        const repaired = await callOpenAIWithImage({
          model: modelName, lg: lang, imageBase64, promptText: repairPrompt(lang, domain, templateKeys)
        }).catch(() => null);
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

      return {
        domain,
        categories,
        coreSummary: core,
        coupangQuery
      };
    }

    // --------- model selection & fallback ---------
    const MODEL_MINI = 'gpt-4o-mini';
    const MODEL_FULL = 'gpt-4o';
    const plan = (() => {
      if (forceModel === '4o') return [MODEL_FULL];
      if (forceModel === 'mini') return [MODEL_MINI, MODEL_FULL];
      return [MODEL_MINI, MODEL_FULL];
    })();

    let usedModel = null;
    let fellBack = false;
    let lastResult = null;

    for (let i=0; i<plan.length; i++){
      usedModel = plan[i];
      const result = await runOnce(usedModel).catch((e) => {
        console.error('[openai-error]', usedModel, e?.message || e);
        return null;
      });

      if (!result) {
        if (i < plan.length - 1) fellBack = true;
        continue;
      }

      lastResult = result;

      const categoriesEmpty = allEmptySummaries(lang, result.categories);
      const coreEmpty = !result.coreSummary || result.coreSummary === L(lang).empty;
      if (categoriesEmpty && coreEmpty) {
        if (i < plan.length - 1) { fellBack = true; continue; }
      }
      break;
    }

    if (!lastResult) {
      return res.status(500).json({ success:false, message:'OCR/요약에 실패했습니다.' });
    }

    // (수정사항2) 추정 모드 간단 생성: coupangQuery 또는 coreSummary 첫 줄 기반
    const firstCoreLine = String(lastResult.coreSummary || '')
      .split('\n').map(s=>s.trim()).filter(Boolean)[0] || '';
    const basis = String(lastResult.coupangQuery || firstCoreLine || '').trim();
    const guessSummary = basis
      ? `추정 분석 — ${basis}\n※ 추정 결과임`
      : '추정 결과 없음';

    return res.json({
      success: true,
      payload: { ...lastResult, guessSummary }, // ★ 추정 섹션 포함
      meta: { model_used: usedModel, fallback_used: fellBack }
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ success:false, message: e.message });
  }
}
