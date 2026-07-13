import Client from "meilisearch";
import { MEILISEARCH_URL, MEILISEARCH_API_KEY, INDEX_NAME } from "./config";
import { logger } from "./logger";

export const client = new Client({
  host: MEILISEARCH_URL!,
  apiKey: MEILISEARCH_API_KEY,
});

export const ensureIndexExists = async () => {
  try {
    await client.getIndex(INDEX_NAME);
    logger.info(`Index \`${INDEX_NAME}\` already exists.`);
  } catch (e: any) {
    if (e.code === "index_not_found") {
      try {
        await client.createIndex(INDEX_NAME, { primaryKey: "Id" });
        logger.info(`Index \`${INDEX_NAME}\` created successfully.`);
      } catch (createError: any) {
        logger.error(`Failed to create index: ${createError.message}`);
        throw createError;
      }
    } else {
      logger.error(`Unexpected error when getting index: ${e.message}`);
      throw e;
    }
  }

  try {
    const index = client.index(INDEX_NAME);

    await index.updateFilterableAttributes([
      "Type",
      "MediaType",
      "IsFolder",
      "Container",
      "OfficialRating",
      // Music: allow narrowing results to a specific album/artist.
      "Album",
      "AlbumId",
      "AlbumArtist",
      "Artists",
    ]);
    logger.info("Updated filterable attributes.");

    await index.updateSortableAttributes([
      "Name",
      "ProductionYear",
      "CriticRating",
      "RunTimeTicks",
      // Music: allow ordering tracks by disc/track number.
      "ParentIndexNumber",
      "IndexNumber",
    ]);
    logger.info("Updated sortable attributes.");
  } catch (e: any) {
    logger.error(`Failed to update attributes: ${e.message}`);
    throw e;
  }
};
