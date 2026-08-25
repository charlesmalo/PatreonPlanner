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
  administer: boolean;
  /**
   * What this staff member may do beyond being staff. A rendering hint only — every endpoint
   * behind these controls checks the same permission server-side and refuses regardless.
   * Empty for anyone who is not staff here; expanded to the full set for an owner, whose
   * stored column is empty because their powers come from the role.
   */
  permissions: StaffPermission[];
}

export interface RecommendationLink {
  id: string;
  url: string;
  label: string | null;
  isPreferred: boolean;
}

export interface TitleSummary {
  /** The catalogue row's id — what the availability endpoint keys on. */
  id: string;
  tmdbId: number;
  mediaType: 'MOVIE' | 'TV' | 'COLLECTION';
  name: string;
  year: number | null;
  posterPath: string | null;
}

export interface CatalogResult {
  tmdbId: number;
  mediaType: 'MOVIE' | 'TV' | 'COLLECTION';
  name: string;
  year: number | null;
  posterPath: string | null;
  overview: string | null;
}

export interface AvailabilityOffer {
  providerId: number;
  providerName: string;
  logoPath: string | null;
  kind: 'FLATRATE' | 'FREE' | 'ADS' | 'RENT' | 'BUY';
  displayPriority: number;
}

export interface Availability {
  /** ISO-3166-1 alpha-2. Availability without its region answers the wrong question. */
  region: string;
  /** The upstream's watch page; null when it gives none. */
  link: string | null;
  offers: AvailabilityOffer[];
}

export interface WatchOrderItem {
  position: number;
  customTitle: string | null;
  note: string | null;
  title: TitleSummary | null;
}

export interface CreatorNote {
  id: string;
  kind: 'NOTE' | 'TIMELINE';
  body: string;
  /** Only ever set on a TIMELINE note. */
  plannedFor: string | null;
  createdAt: string;
  author: { id: string; fullName: string | null; avatarUrl: string | null };
}

export type StaffPermission =
  | 'MOVE_ENTRIES'
  | 'EDIT_ENTRIES'
  | 'HANDLE_REPORTS'
  | 'WRITE_NOTES'
  | 'MANAGE_THEMES';

export interface StaffMember {
  userId: string;
  role: string;
  /** Ignored for an owner, who holds everything by role. */
  permissions: StaffPermission[];
  fullName: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface StaffInviteSummary {
  id: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

export interface StaffList {
  members: StaffMember[];
  invites: StaffInviteSummary[];
}

export interface ThemeSummary {
  id: string;
  name: string;
  entryCount: number;
}

export interface ReactionCount {
  emote: string;
  count: number;
  /** Whether the reader themselves reacted with it. */
  reacted: boolean;
}

export interface Recommendation {
  /** Enthusiasm, kept apart from demand — never an input to the board's ordering. */
  reactions?: ReactionCount[];
  /** Floated to the top of its column by the server, whatever the sort. */
  isCreatorPick?: boolean;
  /** What the board ranks by: the sum of what each voter's tier is worth. */
  weightedScore?: number;
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
  /** Null for an external link, and until the first background refresh lands. */
  availability: Availability | null;
  /** Empty for every type but WATCH_ORDER. */
  watchOrderItems: WatchOrderItem[];
  /** TIMELINE notes only — editor commentary never reaches the board. */
  notes: CreatorNote[];
  /** The entry on this page that contains this one, if any. A per-board projection. */
  parentId: string | null;
  themes: Array<{ id: string; name: string }>;
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
  /** A watch order's text is mostly in its steps; a queue without them reviews only a title. */
  watchOrderItems: WatchOrderItem[];
  /** Both kinds: the queue is where a moderator reads their own commentary. */
  notes: CreatorNote[];
}

export interface NotificationPayload {
  recommendationId: string;
  title: string;
  creatorSlug: string;
  creatorName: string;
  status?: 'PENDING' | 'ACCEPTED' | 'ACTIVE' | 'COMPLETED' | 'REJECTED' | 'DELETED';
  reason?: string;
}

export interface Notification {
  id: string;
  type: 'ENTRY_STATUS_CHANGED' | 'ENTRY_FLAGGED';
  /** A snapshot taken when the event happened, not a live view of the entry. */
  payload: NotificationPayload;
  readAt: string | null;
  createdAt: string;
}

export interface DiscoveredCreator {
  id: string;
  slug: string;
  displayName: string;
  /** On the reader's own shortlist. */
  favorited: boolean;
  /** The reader has a membership here, active or lapsed. */
  supported: boolean;
}
