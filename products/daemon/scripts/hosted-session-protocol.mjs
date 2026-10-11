import assert from 'node:assert/strict';

/** Deterministic synthetic protocol peer. These answers have no calibration value. */
export function syntheticSystemOneAnswers(questions) {
  assert(questions && typeof questions === 'object' && !Array.isArray(questions), 'Expected SystemOne questions');
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    if (question.type === 'noul') return [name, { type: 'noul', noul: 0.01 }];
    if (question.type === 'score') {
      assert(Array.isArray(question.criteria) && question.criteria.length > 0, 'Expected score criteria');
      return [name, {
        type: 'score', score: 0, confidence: 0.99,
        legend: Object.fromEntries(question.criteria.map((label, index) => [String(index), label])),
        probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 0 ? 1 : 0])),
      }];
    }
    assert.equal(question.type, 'choice', 'Unexpected SystemOne question type');
    assert(question.criteria && !Array.isArray(question.criteria), 'Expected choice criteria');
    const choices = Object.keys(question.criteria);
    assert(choices.length > 0, 'Expected nonempty choice criteria');
    const selected = choices.includes('converse') ? 'converse' : choices.includes('act') ? 'act' : choices[0];
    return [name, { type: 'choice', choice: selected, confidence: 0.99,
      probabilities: Object.fromEntries(choices.map(key => [key, key === selected ? 1 : 0])),
    }];
  }));
}

/** Incremental UTF-8 SSE decoding, including frames split between byte chunks. */
export function sessionEventDecoder(onEvent) {
  const decoder = new TextDecoder();
  let pending = '';
  return bytes => {
    pending += decoder.decode(bytes, { stream: true });
    assert(pending.length < 1_048_576, 'Session event buffer exceeded its bound');
    let end;
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      if (data) onEvent(JSON.parse(data));
    }
  };
}
