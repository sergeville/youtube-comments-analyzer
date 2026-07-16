// Document mindmap queries (story yca-9) — paste into Neo4j Browser (http://localhost:7474).
// Model:
//   (:YouTubeVideo)-[:HAS_CHAPTER {index}]->(:Chapter)
//   (:Chapter)-[:HAS_PARAGRAPH {index}]->(:Paragraph)
//   (:Paragraph)-[:MENTIONS]->(:Concept)
//   (:Chapter)-[:NEXT]->(:Chapter) ; (:Paragraph)-[:NEXT]->(:Paragraph)
//
// Replace the :param below (or edit the literal) with your video id.
:param videoId => "1mvlBz6pj1I";

// 1. Full mindmap for a video: video -> chapters -> paragraphs -> concepts.
//    Graph view recommended. For a big transcript, start with query 2 or 5.
MATCH (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(ch:Chapter)-[:HAS_PARAGRAPH]->(p:Paragraph)
OPTIONAL MATCH (p)-[:MENTIONS]->(co:Concept)
RETURN v, ch, p, co;

// 2. Chapter spine only: video -> chapters in reading order (the mindmap's backbone).
MATCH path = (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(:Chapter)
OPTIONAL MATCH nextPath = (:Chapter)-[:NEXT]->(:Chapter)
RETURN path, nextPath;

// 3. One chapter drill-down: its paragraphs (in order) and their concepts.
//    Set the chapter index you want.
MATCH (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(ch:Chapter {index: 5})-[:HAS_PARAGRAPH]->(p:Paragraph)
OPTIONAL MATCH (p)-[:MENTIONS]->(co:Concept)
RETURN ch, p, co
ORDER BY p.index;

// 4. Concept-centric: "which chapters/paragraphs talk about X?"
MATCH (co:Concept {name: "rag"})<-[:MENTIONS]-(p:Paragraph)<-[:HAS_PARAGRAPH]-(ch:Chapter)<-[:HAS_CHAPTER]-(v:YouTubeVideo {id: $videoId})
RETURN co, p, ch, v;

// 5. Bridge concepts — the mindmap cross-links: concepts appearing in 2+ chapters,
//    with how many chapters each threads through. Great table + graph overview.
MATCH (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(ch:Chapter)-[:HAS_PARAGRAPH]->(:Paragraph)-[:MENTIONS]->(co:Concept)
WITH co, count(DISTINCT ch) AS chapters, collect(DISTINCT ch.title) AS chapterTitles
WHERE chapters >= 2
RETURN co.name AS concept, chapters, chapterTitles
ORDER BY chapters DESC, concept ASC;

// 6. Bridge subgraph (visual): only paragraphs whose concept spans 2+ chapters, so the
//    graph view shows how distant chapters connect through shared ideas.
MATCH (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(ch:Chapter)-[:HAS_PARAGRAPH]->(p:Paragraph)-[:MENTIONS]->(co:Concept)
WITH co, collect(DISTINCT ch) AS chs
WHERE size(chs) >= 2
MATCH (co)<-[m:MENTIONS]-(p:Paragraph)<-[:HAS_PARAGRAPH]-(ch:Chapter)
WHERE ch IN chs
RETURN co, m, p, ch;

// 7. Top concepts by paragraph frequency (table).
MATCH (v:YouTubeVideo {id: $videoId})-[:HAS_CHAPTER]->(:Chapter)-[:HAS_PARAGRAPH]->(p:Paragraph)-[:MENTIONS]->(co:Concept)
RETURN co.name AS concept, count(DISTINCT p) AS paragraphs
ORDER BY paragraphs DESC, concept ASC
LIMIT 25;
