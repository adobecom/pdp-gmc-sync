const { Core } = require("@adobe/aio-sdk");
const { makeClients } = require("../lib/gmcClients");
const { resolveAccount, resolveDataSource } = require("../lib/config");
const { mapProduct, sanitizeOfferId } = require("../lib/mapProduct");
const { validateRows, MAX_CHUNK } = require("../lib/validate");
const { insertWithRetry } = require("../lib/insertWithRetry");
const { runPool } = require("../lib/concurrency");
const { initState, recordPushes } = require("../lib/syncState");
const { invalidatePriceRecords } = require("../lib/priceStore");
const { isValidImsToken } = require("../lib/imsAuth");
const { redact } = require("../lib/redact");
const { errorResponse, checkMissingRequestInputs } = require("../utils");

const DEFAULT_CONCURRENCY = 15;

function areParamsValid(params, logger) {
    const missing = checkMissingRequestInputs(params, ["products"], ["Authorization"]);
    if (missing) return errorResponse(400, missing, logger);

    if (!Array.isArray(params.products) || params.products.length === 0) {
        return errorResponse(400, "products must be a non-empty array", logger);
    }

    if (params.products.length > MAX_CHUNK) {
        return errorResponse(400, `chunk too large; send <= ${MAX_CHUNK} products per call`, logger);
    }

    return true;
}

async function main(params) {
    const logger = Core.Logger("sync-products", { level: params.LOG_LEVEL || "info" });
    logger.debug(redact(params));

    const validParamsValue = areParamsValid(params, logger);
    if (validParamsValue !== true) {
        return validParamsValue;
    }

    try {
        if (!(await isValidImsToken(params))) {
            return errorResponse(401, "invalid IMS token", logger);
        }
    } catch {
        logger.error("IMS token validation request failed");
        return errorResponse(503, "unable to validate IMS token", logger);
    }

    const statePromise = initState(logger);

    let accountId, dataSource, productInputs;

    try {
        accountId = resolveAccount(params);
        dataSource = resolveDataSource(params, accountId);
        ({ productInputs } = makeClients(params));
    } catch (e) {
        logger.error(`config/auth error: ${e.message}`);
        return errorResponse(500, "server misconfigured — see logs", logger);
    }

    const { valid, invalid } = validateRows(params.products);

    const concurrency =
        Number.isInteger(params.concurrency) && params.concurrency > 0 && params.concurrency <= 50
            ? params.concurrency
            : DEFAULT_CONCURRENCY;

    const inserted = await runPool(
        valid,
        async row => {
            let input;
            try {
                input = mapProduct(row);
            } catch (e) {
                return {
                    offerId: sanitizeOfferId(row.product_id) || row.product_id,
                    ok: false,
                    status: "MAP_ERROR",
                    message: e.message
                };
            }
            return insertWithRetry(
                productInputs,
                {
                    parent: `accounts/${accountId}`,
                    dataSource,
                    productInput: input
                },
                input.offerId,
                logger
            );
        },
        concurrency
    );

    const rejected = invalid.map(v => ({
        offerId: sanitizeOfferId(v.product_id) || v.product_id,
        ok: false,
        status: "VALIDATION_ERROR",
        message: v.reason
    }));

    const results = [...inserted, ...rejected];
    const succeeded = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);

    const pushedIds = succeeded.map(r => r.offerId);
    const failedItems = failed.map(r => ({
        productId: r.offerId,
        reason: r.status ? `${r.status}: ${r.message}` : r.message || "unknown error"
    }));

    const state = await statePromise;
    await recordPushes(state, params.GMC_ENV, accountId, pushedIds, logger);
    await invalidatePriceRecords(params, pushedIds, logger);

    const body = {
        env: params.GMC_ENV,
        dataSource,
        submitted: params.products.length,
        succeeded: succeeded.length,
        failed: failed.length,
        pushedIds,
        failedItems
    };
    logger.info(
        `sync-products env=${params.GMC_ENV} submitted=${body.submitted} ok=${body.succeeded} failed=${body.failed}`
    );
    return { statusCode: 200, body };
}

module.exports.main = main;
