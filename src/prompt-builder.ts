export function buildMergedPrompt(transcriptionText: string, filterText?: string): string {
  const relevanceSection = filterText
    ? `Channel filter text: ${filterText}

First, judge whether the content meets the channel's filter criteria. Include "relevant": true or "relevant": false in your JSON response. If content does not meet the criteria, set relevant to false.`
    : '';

  const minimalInstruction = filterText
    ? `\n\nIMPORTANT: If content is NOT relevant, return ONLY {"relevant": false} without generating summary, takeaways, sentiment, or entities.`
    : '';

  return `You are a content analyst. Analyze the following video transcription and produce a structured JSON response containing summary, key takeaways, overall sentiment, and entity mentions.${relevanceSection ? '\n\n' + relevanceSection : ''}${minimalInstruction}

Return ONLY valid JSON with this structure:
{
  "summary": "A concise 2-3 sentence summary of the relevant content",
  "takeaways": [
    { "text": "Key takeaway description", "timestamp": "T:ss" }
  ],
  "overall_sentiment": {
    "score": 3,
    "label": "Neutral"
  },
  "entities": [
    { "entity_name": "ExampleEntity", "entity_type": "other", "sentiment": "Positive" }
  ]${relevanceSection ? ',\n  "relevant": true' : ''}
}

Rules:
- Each takeaway must include a timestamp in "T:ss" format where ss is the start seconds as an integer
- Focus only on topics matching the channel filter text
- Keep takeaways concise and actionable

Sentiment score scale (integer 1-5):
1 = Very Negative
2 = Negative
3 = Neutral
4 = Positive
5 = Very Positive

Entity types: card, set, player, format, archetype, company, event, rules, other
Sentiment labels for entities: Positive, Negative, Neutral

Transcription:
${transcriptionText}`;
}