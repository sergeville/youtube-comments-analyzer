// Idempotent Neo4j schema for youtube-comments-analyzer (story yca-1).
// Human-readable copy of SCHEMA_STATEMENTS in neo4j-lib.mjs — keep the two in sync.
// Safe to paste into Neo4j Browser or apply via the import script (ensureSchema).

// Uniqueness constraints (business keys — never Neo4j internal ids)
CREATE CONSTRAINT youtube_channel_id IF NOT EXISTS FOR (ch:YouTubeChannel) REQUIRE ch.id IS UNIQUE;
CREATE CONSTRAINT youtube_video_id IF NOT EXISTS FOR (v:YouTubeVideo) REQUIRE v.id IS UNIQUE;
CREATE CONSTRAINT youtube_comment_id IF NOT EXISTS FOR (c:YouTubeComment) REQUIRE c.id IS UNIQUE;
CREATE CONSTRAINT youtube_author_id IF NOT EXISTS FOR (a:YouTubeAuthor) REQUIRE a.id IS UNIQUE;
CREATE CONSTRAINT comment_category_name IF NOT EXISTS FOR (cat:CommentCategory) REQUIRE cat.name IS UNIQUE;
CREATE CONSTRAINT classification_profile_name IF NOT EXISTS FOR (p:ClassificationProfile) REQUIRE p.name IS UNIQUE;
CREATE CONSTRAINT comment_context_key IF NOT EXISTS FOR (ctx:CommentContext) REQUIRE ctx.key IS UNIQUE;

// Document mindmap model (story yca-9): chapters, paragraphs, and shared concepts.
CREATE CONSTRAINT document_chapter_id IF NOT EXISTS FOR (ch:Chapter) REQUIRE ch.id IS UNIQUE;
CREATE CONSTRAINT document_paragraph_id IF NOT EXISTS FOR (p:Paragraph) REQUIRE p.id IS UNIQUE;
CREATE CONSTRAINT document_concept_name IF NOT EXISTS FOR (co:Concept) REQUIRE co.name IS UNIQUE;

// Range indexes for the verify aggregations
CREATE INDEX youtube_comment_category IF NOT EXISTS FOR (c:YouTubeComment) ON (c.category);
CREATE INDEX youtube_comment_parent IF NOT EXISTS FOR (c:YouTubeComment) ON (c.parent);
CREATE INDEX document_chapter_video IF NOT EXISTS FOR (ch:Chapter) ON (ch.videoId);

// Schema version marker (bump alongside SCHEMA_VERSION in neo4j-lib.mjs)
MERGE (s:SchemaVersion {name: 'youtube-comments'}) SET s.version = 4, s.appliedAt = datetime();
