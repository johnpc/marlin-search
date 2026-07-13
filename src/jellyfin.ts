import axios from "axios";
import {
  JELLYFIN_URL,
  JELLYFIN_API_KEY,
  BATCH_SIZE,
  INDEX_NAME,
} from "./config";
import { logger } from "./logger";
import { client } from "./meilisearch";

// Retry a request a few times on transient failures (e.g. a 502 from a
// reverse proxy in front of Jellyfin) with exponential backoff. Without
// this, a single blip aborts the entire scrape.
const withRetry = async <T>(
  fn: () => Promise<T>,
  description: string,
  attempts = 4
): Promise<T> => {
  let lastError: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt < attempts) {
        const delayMs = 1000 * 2 ** (attempt - 1);
        logger.warn(
          `${description} failed (attempt ${attempt}/${attempts}): ${error.message}. Retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
};

export const scrapeJellyfin = async (): Promise<{
  status: string;
  message: string;
}> => {
  const headers = { "X-Emby-Token": JELLYFIN_API_KEY! };
  const batchSize = BATCH_SIZE || 1000;
  const allowedTypes = new Set([
    "Movie",
    "Series",
    "Episode",
    "MusicArtist",
    "MusicAlbum",
    "Audio",
  ]);

  try {
    for (const type of allowedTypes) {
      logger.info(`Fetching items of type ${type} from Jellyfin...`);

      const totalItemsResponse = await withRetry(
        () =>
          axios.get(`${JELLYFIN_URL}/Items`, {
            params: {
              Recursive: true,
              StartIndex: 0,
              Limit: 1,
              IncludeItemTypes: type,
            },
            headers,
            timeout: 30000,
          }),
        `Fetching total count for type ${type}`
      );

      const totalItems = totalItemsResponse.data.TotalRecordCount;
      const totalBatches = Math.ceil(totalItems / batchSize);
      logger.info(
        `Total ${type} items found: ${totalItems}. Fetching in ${totalBatches} batches of ${batchSize}...`
      );

      let addedForType = 0;
      const meiliIndex = client.index(INDEX_NAME);

      for (let index = 0; index < totalBatches; index++) {
        const startIndex = index * batchSize;
        logger.info(
          `Fetching batch ${
            index + 1
          }/${totalBatches} of type ${type} starting at index ${startIndex}...`
        );

        const response = await withRetry(
          () =>
            axios.get(`${JELLYFIN_URL}/Items`, {
              params: {
                Recursive: true,
                StartIndex: startIndex,
                Limit: batchSize,
                IncludeItemTypes: type,
                fields:
                  "Id,Name,Type,MediaType,IsFolder,Container,ProductionYear,OriginalTitle,Overview,CriticRating,OfficialRating,Genres,Studios,People,Taglines,RunTimeTicks,Artists,AlbumArtist,AlbumArtists,Album,AlbumId,ArtistItems,IndexNumber,ParentIndexNumber",
              },
              headers,
              timeout: 30000,
            }),
          `Fetching batch ${index + 1}/${totalBatches} of type ${type}`
        );

        logger.info(
          `Batch ${
            index + 1
          }/${totalBatches} of type ${type} fetched successfully.`
        );
        const batchItems = response.data.Items || [];

        const filteredItems = batchItems.map((item: any) => ({
          Id: item.Id,
          Name: item.Name,
          Type: item.Type,
          MediaType: item.MediaType,
          IsFolder: item.IsFolder,
          Container: item.Container,
          ProductionYear: item.ProductionYear,
          OriginalTitle: item.OriginalTitle,
          Overview: item.Overview,
          CriticRating: item.CriticRating,
          OfficialRating: item.OfficialRating,
          Genres: item.Genres,
          Studios: item.Studios,
          People: item.People,
          Taglines: item.Taglines,
          RunTimeTicks: item.RunTimeTicks,
          // Music-specific metadata. Present only for Audio/MusicAlbum/MusicArtist
          // items; left undefined (and thus omitted) for other media types.
          Artists: item.Artists,
          AlbumArtist: item.AlbumArtist,
          AlbumArtists: Array.isArray(item.AlbumArtists)
            ? item.AlbumArtists.map((a: any) => a?.Name).filter(Boolean)
            : undefined,
          Album: item.Album,
          AlbumId: item.AlbumId,
          IndexNumber: item.IndexNumber,
          ParentIndexNumber: item.ParentIndexNumber,
        }));

        // Index each batch as it arrives so that a later failure never
        // discards progress already made for this type.
        if (filteredItems.length > 0) {
          await withRetry(
            () => meiliIndex.addDocuments(filteredItems),
            `Adding batch ${index + 1}/${totalBatches} of type ${type} to MeiliSearch`
          );
          addedForType += filteredItems.length;
        }
      }

      logger.info(
        `Finished type ${type}: added ${addedForType} items to MeiliSearch.`
      );
    }

    return {
      status: "success",
      message: `All items have been added to MeiliSearch.`,
    };
  } catch (error: any) {
    logger.error(`Error occurred: ${error.message}`);
    return {
      status: "error",
      message: `Error occurred: ${error.message}`,
    };
  }
};
