export interface SessionUser {
  id: string;
  patreonUserId: string;
  fullName: string | null;
  avatarUrl: string | null;
}

export interface Capabilities {
  view: boolean;
  upvote: boolean;
  submit: boolean;
  moderate: boolean;
}

export interface RecommendationLink {
  url: string;
  label: string | null;
}

export interface TitleSummary {
  tmdbId: number;
  mediaType: 'MOVIE' | 'TV';
  name: string;
  year: number | null;
  posterPath: string | null;
}

export interface CatalogResult {
  tmdbId: number;
  mediaType: 'MOVIE' | 'TV';
  name: string;
  year: number | null;
  posterPath: string | null;
  overview: string | null;
}

export interface Recommendation {
  id: string;
  type: string;
  customTitle: string;
  description: string | null;
  status: string;
  upvoteCount: number;
  /** Whether the current viewer upvoted this. False for anonymous readers. */
  hasUpvoted: boolean;
  /** Present when the entry is bound to a catalogue title. */
  title: TitleSummary | null;
  createdAt: string;
  links: RecommendationLink[];
  submittedBy: { id: string; fullName: string | null; avatarUrl: string | null };
}

export interface Board {
  items: Recommendation[];
  nextCursor: string | null;
}

export interface CreatorProfile {
  id: string;
  slug: string;
  displayName: string;
  baseUrl: string | null;
  tiers: Array<{ id: string; title: string; amountCents: number; order: number }>;
}

export interface SubmitResult {
  duplicate: boolean;
  recommendation: Recommendation;
}

export interface UpvoteResult {
  upvoted: boolean;
  upvoteCount: number;
}

export interface FlagSummary {
  id: string;
  reason: string;
  note: string | null;
  createdAt: string;
  flaggedBy: { id: string; fullName: string | null };
}

/**
 * The review queue's own shape. It exposes the submitter and the open flags, neither of which
 * the patron board's read model returns — the two are deliberately different projections.
 */
export interface ReviewQueueItem {
  id: string;
  customTitle: string;
  description: string | null;
  status: string;
  upvoteCount: number;
  createdAt: string;
  submittedBy: { id: string; fullName: string | null; avatarUrl: string | null };
  openFlagCount: number;
  flags: FlagSummary[];
}
