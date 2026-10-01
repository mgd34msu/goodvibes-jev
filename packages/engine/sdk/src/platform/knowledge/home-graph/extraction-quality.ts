import {
  hasUsefulKnowledgeExtractionText,
} from '../extraction-policy.js';

export async function isUnusableHomeGraphExtractionText(value: string | undefined): Promise<boolean> {
  return !(await hasUsefulKnowledgeExtractionText(value));
}
