#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv, resolveConfig, cypherRows } from "./neo4j-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");

async function firstRow(config, statement) {
  return (await cypherRows(config, statement))[0] || [];
}

async function loadSummary(config) {
  const statements = [
    "MATCH (v:YouTubeVideo) RETURN count(v)",
    "MATCH (comment:YouTubeComment) RETURN count(comment)",
    "MATCH (author:YouTubeAuthor) RETURN count(author)",
    "MATCH (:YouTubeComment)-[reply:REPLY_TO]->(:YouTubeComment) RETURN count(reply)",
    "MATCH (category:CommentCategory) RETURN count(category)",
    "MATCH (profile:ClassificationProfile) RETURN count(profile)",
    "MATCH (context:CommentContext) RETURN count(context)",
  ];
  const counts = await Promise.all(statements.map((statement) => firstRow(config, statement)));
  const [videos, comments, authors, replyEdges, categories, classificationProfiles, contexts] =
    counts.map(([count]) => count);
  return { videos, comments, authors, replyEdges, categories, classificationProfiles, contexts };
}

async function loadContextHealth(config) {
  const [missingOrDuplicateContexts, contextLabelMismatches] = await firstRow(config, `
    MATCH (comment:YouTubeComment)
    OPTIONAL MATCH (comment)-[relation:IN_CONTEXT]->(context:CommentContext)
    WITH comment, count(relation) AS edges,
         count(CASE WHEN relation.label = context.name THEN 1 END) AS matchingLabels
    RETURN sum(CASE WHEN edges = 1 THEN 0 ELSE 1 END),
           sum(CASE WHEN edges = 1 AND matchingLabels = 1 THEN 0 ELSE 1 END)
  `);
  const [invalidContextTaxonomy] = await firstRow(config, `
    MATCH (context:CommentContext)
    OPTIONAL MATCH (context)-[subcategory:SUBCLASS_OF]->(:CommentCategory)
    OPTIONAL MATCH (context)-[profile:VALID_FOR]->(:ClassificationProfile)
    WITH context, count(DISTINCT subcategory) AS categories, count(DISTINCT profile) AS profiles
    RETURN sum(CASE WHEN categories = 1 AND profiles = 1
                         AND size(split(context.name, " ")) >= 1
                         AND size(split(context.name, " ")) <= 3
                    THEN 0 ELSE 1 END)
  `);
  const [coverageMismatches] = await firstRow(config, `
    MATCH (video:YouTubeVideo)-[:HAS_COMMENT]->(comment:YouTubeComment)-[:IN_CONTEXT]->(context:CommentContext)
    WITH video, context, count(DISTINCT comment) AS actual
    OPTIONAL MATCH (video)-[coverage:COVERS]->(context)
    RETURN sum(CASE WHEN coverage.commentCount = actual THEN 0 ELSE 1 END)
  `);
  const [discussionMismatches] = await firstRow(config, `
    MATCH (author:YouTubeAuthor)-[:WROTE]->(comment:YouTubeComment)-[:IN_CONTEXT]->(context:CommentContext)
    WITH author, context, count(DISTINCT comment) AS actual
    OPTIONAL MATCH (author)-[discussion:DISCUSSES]->(context)
    RETURN sum(CASE WHEN discussion.commentCount = actual THEN 0 ELSE 1 END)
  `);
  const [coverageEdges, expectedCoverageEdges] = await firstRow(config, `
    OPTIONAL MATCH (:YouTubeVideo)-[coverage:COVERS]->(:CommentContext)
    WITH count(coverage) AS actual
    CALL {
      MATCH (video:YouTubeVideo)-[:HAS_COMMENT]->(:YouTubeComment)-[:IN_CONTEXT]->(context:CommentContext)
      RETURN count(DISTINCT [video.id, context.key]) AS expected
    }
    RETURN actual, expected
  `);
  const [discussionEdges, expectedDiscussionEdges] = await firstRow(config, `
    OPTIONAL MATCH (:YouTubeAuthor)-[discussion:DISCUSSES]->(:CommentContext)
    WITH count(discussion) AS actual
    CALL {
      MATCH (author:YouTubeAuthor)-[:WROTE]->(:YouTubeComment)-[:IN_CONTEXT]->(context:CommentContext)
      RETURN count(DISTINCT [author.id, context.key]) AS expected
    }
    RETURN actual, expected
  `);

  return {
    missingOrDuplicateContexts,
    contextLabelMismatches,
    invalidContextTaxonomy,
    coverageMismatches,
    discussionMismatches,
    coverageEdgeDelta: coverageEdges - expectedCoverageEdges,
    discussionEdgeDelta: discussionEdges - expectedDiscussionEdges,
  };
}

async function loadCategories(config) {
  const rows = await cypherRows(config, `
    MATCH (category:CommentCategory)<-[:IN_CATEGORY]-(comment:YouTubeComment)
    RETURN category.name AS category, count(comment) AS comments
    ORDER BY comments DESC, category ASC
  `);
  return rows.map(([category, comments]) => ({ category, comments }));
}

function requireCredentials() {
  if (!process.env.NEO4J_USER || !process.env.NEO4J_PASSWORD) {
    throw new Error("Set NEO4J_USER and NEO4J_PASSWORD.");
  }
}

async function buildReport(config) {
  const [summary, contextHealth, categories] = await Promise.all([
    loadSummary(config),
    loadContextHealth(config),
    loadCategories(config),
  ]);
  const ok = Object.values(contextHealth).every((value) => value === 0);
  return { ok, summary, contextHealth, categories };
}

async function verify() {
  loadDotEnv(PROJECT_DIR);
  requireCredentials();
  // resolveConfig enforces the TLS rule (non-localhost must be https).
  const report = await buildReport(resolveConfig());
  console.log(JSON.stringify(report, null, 2));
  return report.ok;
}

async function main() {
  try {
    const ok = await verify();
    if (!ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
