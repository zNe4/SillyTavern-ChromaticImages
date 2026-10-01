/**
 * @file Message inspector and durable-state classifier for Chromatic Images.
 *
 * Synchronously inspects an active assistant message by combining reader,
 * proposal parser/validator, and durable result parser into a normalized
 * classification result with fresh chat-identity safety checks.
 */

import { readActiveAssistantMessage } from './message-reader.js';
import { parseImageProposalRecords } from './proposal-parser.js';
import {
    validateImageProposalRecords,
    selectMvpImageProposal,
} from './proposal-validator.js';
import { parseImageResultStates } from './result-parser.js';

/**
 * Inspects an active assistant message by ID and classifies its Chromatic Images state.
 *
 * @param {unknown} messageId - The index or ID of the assistant message to inspect.
 * @returns {{
 *     status: 'ignored' | 'chat-changed' | 'empty' | 'proposal' | 'reviewable-result' | 'finalized-result' | 'unsupported-multiple' | 'invalid-protocol',
 *     reason?: string,
 *     chatId?: unknown,
 *     messageId?: number,
 *     currentChatId?: unknown,
 *     proposal?: object,
 *     result?: object,
 *     image?: object,
 *     counts?: { proposals: number, reviewable: number, finalized: number },
 *     errors?: string[],
 * }}
 */
export function inspectActiveImageMessage(messageId) {
    // Step 1: Read active assistant message
    const readerResult = readActiveAssistantMessage(messageId);
    if (readerResult.status !== 'ready') {
        return {
            status: 'ignored',
            reason: readerResult.status,
        };
    }

    // Step 2: Capture origin snapshot
    const originChatId = readerResult.chatId;
    const normalizedMessageId = readerResult.messageId;
    const rawMessage = readerResult.message;

    // Step 3: Parse proposal state
    const errors = [];
    let validatedProposals = [];

    const proposalParseResult = parseImageProposalRecords(rawMessage);
    if (!proposalParseResult.ok) {
        for (const err of proposalParseResult.errors) {
            if (!errors.includes(err)) {
                errors.push(err);
            }
        }
    } else {
        const proposalValidateResult = validateImageProposalRecords(proposalParseResult.records);
        if (!proposalValidateResult.ok) {
            for (const err of proposalValidateResult.errors) {
                if (!errors.includes(err)) {
                    errors.push(err);
                }
            }
        } else {
            validatedProposals = proposalValidateResult.proposals;
        }
    }

    // Step 4: Parse durable image state
    const resultParseResult = parseImageResultStates(rawMessage);
    if (!resultParseResult.ok) {
        for (const err of resultParseResult.errors) {
            if (!errors.includes(err)) {
                errors.push(err);
            }
        }
    }

    // Step 5: Fresh chat-identity check
    // SillyTavern/getContext check must happen before returning any actionable state
    // or protocol diagnostics, ensuring stale-chat refusal precedes error reporting.
    let freshContext;
    try {
        if (
            typeof SillyTavern === 'undefined' ||
            !SillyTavern ||
            typeof SillyTavern.getContext !== 'function'
        ) {
            return {
                status: 'ignored',
                reason: 'context-unavailable',
                chatId: originChatId,
                messageId: normalizedMessageId,
            };
        }

        freshContext = SillyTavern.getContext();
    } catch {
        return {
            status: 'ignored',
            reason: 'context-unavailable',
            chatId: originChatId,
            messageId: normalizedMessageId,
        };
    }

    if (!freshContext || typeof freshContext !== 'object') {
        return {
            status: 'ignored',
            reason: 'context-unavailable',
            chatId: originChatId,
            messageId: normalizedMessageId,
        };
    }

    if (freshContext.chatId === null || freshContext.chatId === undefined) {
        return {
            status: 'chat-changed',
            chatId: originChatId,
            messageId: normalizedMessageId,
            currentChatId: null,
        };
    }

    if (freshContext.chatId !== originChatId) {
        return {
            status: 'chat-changed',
            chatId: originChatId,
            messageId: normalizedMessageId,
            currentChatId: freshContext.chatId,
        };
    }

    // Step 6: Protocol errors check
    if (errors.length > 0) {
        return {
            status: 'invalid-protocol',
            chatId: originChatId,
            messageId: normalizedMessageId,
            errors,
        };
    }

    // Step 7: Unified MVP state counting and selection
    const mvpProposalResult = selectMvpImageProposal(validatedProposals);

    const proposalCount = validatedProposals.length;
    const reviewableCount = resultParseResult.reviewable.length;
    const finalizedCount = resultParseResult.finalized.length;
    const totalStateCount = proposalCount + reviewableCount + finalizedCount;

    // Step 8: Empty
    if (totalStateCount === 0) {
        return {
            status: 'empty',
            chatId: originChatId,
            messageId: normalizedMessageId,
        };
    }

    // Step 9: Unsupported multiple
    if (totalStateCount > 1 || mvpProposalResult.status === 'multiple-proposals-not-supported') {
        return {
            status: 'unsupported-multiple',
            chatId: originChatId,
            messageId: normalizedMessageId,
            counts: {
                proposals: proposalCount,
                reviewable: reviewableCount,
                finalized: finalizedCount,
            },
        };
    }

    // Step 10: Proposal
    if (proposalCount === 1 && mvpProposalResult.status === 'ready') {
        return {
            status: 'proposal',
            chatId: originChatId,
            messageId: normalizedMessageId,
            proposal: mvpProposalResult.proposal,
        };
    }

    // Step 11: Reviewable result
    if (reviewableCount === 1) {
        return {
            status: 'reviewable-result',
            chatId: originChatId,
            messageId: normalizedMessageId,
            result: resultParseResult.reviewable[0],
        };
    }

    // Step 12: Finalized result
    if (finalizedCount === 1) {
        return {
            status: 'finalized-result',
            chatId: originChatId,
            messageId: normalizedMessageId,
            image: resultParseResult.finalized[0],
        };
    }

    // Safety fallback
    return {
        status: 'empty',
        chatId: originChatId,
        messageId: normalizedMessageId,
    };
}
