// api/summarize.js
import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY, // 환경변수 (.env에 저장)
    });

    const { imageBase64, lang } = req.body;

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `이 이미지를 ${lang}로 요약해줘` },
            { type: "input_image", image_url: `data:image/png;base64,${imageBase64}` }
          ],
        },
      ],
    });

    res.status(200).json({ result: response.output_text });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
