export type ModerationVerdict = 'PASS' | 'FLAG' | 'BLOCK';

export interface ModerationResultData {
  verdict: ModerationVerdict;
  categories: string[];
  source: 'WORDLIST' | 'ML';
}

/** Design §6 item 5 puts wordlist and ML behind one pipeline; this is the seam. */
export interface Moderator {
  review(text: string): Promise<ModerationResultData>;
}
