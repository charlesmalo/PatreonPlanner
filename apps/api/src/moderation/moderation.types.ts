export type ModerationVerdict = 'PASS' | 'FLAG' | 'BLOCK';

export interface ModerationResultData {
  verdict: ModerationVerdict;
  categories: string[];
  source: 'WORDLIST' | 'ML';
}

export type ModerationSubjectType = 'RECOMMENDATION' | 'NOTE' | 'THEME' | 'FLAG_NOTE';

/**
 * What is being reviewed. Required rather than optional so a call site cannot quietly stop
 * recording: five places run user text through this pipeline, and "someone forgot to record it"
 * would otherwise be a permanent defect class.
 */
export interface ModerationSubject {
  creatorId: string;
  userId: string;
  type: ModerationSubjectType;
  /** Null when the content is rejected and therefore never created. */
  id?: string | null;
}

/** Design §6 item 5 puts wordlist and ML behind one pipeline; this is the seam. */
export interface Moderator {
  /** The board is passed because one implementation of this is a per-creator list. */
  review(text: string, creatorId: string): Promise<ModerationResultData>;
}
