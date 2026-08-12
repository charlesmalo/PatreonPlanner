-- A TMDB collection is another kind of canonical identity. Adding it to MediaType lets a franchise
-- be a Title row, reusing the (tmdbId, mediaType) unique index — TMDB ids are only unique within a
-- media type, so collection 10 and film 10 stay distinct.
--
-- Not reversible: Postgres cannot drop an enum value. Rolling back means recreating the type.
ALTER TYPE "MediaType" ADD VALUE 'COLLECTION';
