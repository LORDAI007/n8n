/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
/* eslint-disable @typescript-eslint/no-this-alias */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import * as jmespath from 'jmespath';
import { DateTime, Duration, Interval, Settings } from 'luxon';

import { augmentArray, augmentObject } from './AugmentObject';
import { SCRIPTING_NODE_TYPES } from './Constants';
import { ApplicationError } from './errors/application.error';
import { ExpressionError, type ExpressionErrorOptions } from './errors/expression.error';
import { getGlobalState } from './GlobalState';
import {
	type IDataObject,
	type IExecuteData,
	type INodeExecutionData,
	type INodeParameters,
	type IPairedItemData,
	type IRunExecutionData,
	type ISourceData,
	type ITaskData,
	type IWorkflowDataProxyAdditionalKeys,
	type IWorkflowDataProxyData,
	type INodeParameterResourceLocator,
	type NodeParameterValueType,
	type WorkflowExecuteMode,
	type ProxyInput,
	NodeConnectionTypes,
} from './Interfaces';
import * as NodeHelpers from './NodeHelpers';
import { deepCopy } from './utils';
import type { Workflow } from './Workflow';
import type { EnvProviderState } from './WorkflowDataProxyEnvProvider';
import { createEnvProvider, createEnvProviderState } from './WorkflowDataProxyEnvProvider';
import { getPinDataIfManualExecution } from './WorkflowDataProxyHelpers';

export function isResourceLocatorValue(value: unknown): value is INodeParameterResourceLocator {
	return Boolean(
		typeof value === 'object' && value && 'mode' in value && 'value' in value && '__rl' in value,
	);
}

const isScriptingNode = (nodeName: string, workflow: Workflow) => {
	const node = workflow.getNode(nodeName);

	return node && SCRIPTING_NODE_TYPES.includes(node.type);
};

export class WorkflowDataProxy {
	private runExecutionData: IRunExecutionData | null;

	private connectionInputData: INodeExecutionData[];

	private timezone: string;

	// TODO: Clean that up at some point and move all the options into an options object
	constructor(
		private workflow: Workflow,
		runExecutionData: IRunExecutionData | null,
		private runIndex: number,
		private itemIndex: number,
		private activeNodeName: string,
		connectionInputData: INodeExecutionData[],
		private siblingParameters: INodeParameters,
		private mode: WorkflowExecuteMode,
		private additionalKeys: IWorkflowDataProxyAdditionalKeys,
		private executeData?: IExecuteData,
		private defaultReturnRunIndex = -1,
		private selfData: IDataObject = {},
		private contextNodeName: string = activeNodeName,
		private envProviderState?: EnvProviderState,
	) {
		this.runExecutionData = isScriptingNode(this.contextNodeName, workflow)
			? runExecutionData !== null
				? augmentObject(runExecutionData)
				: null
			: runExecutionData;

		this.connectionInputData = isScriptingNode(this.contextNodeName, workflow)
			? augmentArray(connectionInputData)
			: connectionInputData;

		this.timezone = workflow.settings?.timezone ?? getGlobalState().defaultTimezone;
		Settings.defaultZone = this.timezone;
	}

	/**
	 * Returns a proxy which allows to query context data of a given node
	 *
	 * @private
	 * @param {string} nodeName The name of the node to get the context from
	 */
	private nodeContextGetter(nodeName: string) {
		const that = this;
		const node = this.workflow.nodes[nodeName];

		if (!that.runExecutionData?.executionData && that.connectionInputData.length > 0) {
			return {}; // incoming connection has pinned data, so stub context object
		}

		if (!that.runExecutionData?.executionData && !that.runExecutionData?.resultData) {
			throw new ExpressionError(
				"The workflow hasn't been executed yet, so you can't reference any context data",
				{
					runIndex: that.runIndex,
					itemIndex: that.itemIndex,
					type: 'no_execution_data',
				},
			);
		}

		return new Proxy(
			{},
			{
				has: () => true,
				ownKeys(target) {
					if (Reflect.ownKeys(target).length === 0) {
						// Target object did not get set yet
						Object.assign(target, NodeHelpers.getContext(that.runExecutionData!, 'node', node));
					}

					return Reflect.ownKeys(target);
				},
				getOwnPropertyDescriptor() {
					return {
						enumerable: true,
						configurable: true,
					};
				},
				get(_, name) {
					if (name === 'isProxy') return true;

					name = name.toString();
					const contextData = NodeHelpers.getContext(that.runExecutionData!, 'node', node);

					return contextData[name];
				},
			},
		);
	}

	private selfGetter() {
		const that = this;

		return new Proxy(
			{},
			{
				has: () => true,
				ownKeys(target) {
					return Reflect.ownKeys(target);
				},

				get(_, name) {
					if (name === 'isProxy') return true;
					name = name.toString();
					return that.selfData[name];
				},
			},
		);
	}

	/**
	 * Returns a proxy which allows to query parameter data of a given node
	 *
	 * @private
	 * @param {string} nodeName The name of the node to query data from
	 * @param {boolean} [resolveValue=true] If the expression value should get resolved
	 */
	private nodeParameterGetter(nodeName: string, resolveValue = true) {
		const that = this;
		const node = this.workflow.nodes[nodeName];

		// `node` is `undefined` only in expressions in credentials

		return new Proxy(node?.parameters ?? {}, {
			has: () => true,
			ownKeys(target) {
				return Reflect.ownKeys(target);
			},
			getOwnPropertyDescriptor() {
				return {
					enumerable: true,
					configurable: true,
				};
			},
			get(target, name) {
				if (name === 'isProxy') return true;
				if (name === 'toJSON') return () => deepCopy(target);

				name = name.toString();

				let returnValue: NodeParameterValueType;
				if (name[0] === '&') {
					const key = name.slice(1);
					if (!that.siblingParameters.hasOwnProperty(key)) {
						throw new ApplicationError('Could not find sibling parameter on node', {
							extra: { nodeName, parameter: key },
						});
					}
					returnValue = that.siblingParameters[key];
				} else {
					if (!node.parameters.hasOwnProperty(name)) {
						// Parameter does not exist on node
						return undefined;
					}

					returnValue = node.parameters[name];
				}

				// Avoid recursion
				if (returnValue === `={{ $parameter.${name} }}`) return undefined;

				if (isResourceLocatorValue(returnValue)) {
					if (returnValue.__regex && typeof returnValue.value === 'string') {
						const expr = new RegExp(returnValue.__regex);
						const extracted = expr.exec(returnValue.value);
						if (extracted && extracted.length >= 2) {
							returnValue = extracted[1];
						} else {
							return returnValue.value;
						}
					} else {
						returnValue = returnValue.value;
					}
				}

				if (resolveValue && typeof returnValue === 'string' && returnValue.charAt(0) === '=') {
					// The found value is an expression so resolve it
					return that.workflow.expression.getParameterValue(
						returnValue,
						that.runExecutionData,
						that.runIndex,
						that.itemIndex,
						that.activeNodeName,
						that.connectionInputData,
						that.mode,
						that.additionalKeys,
						that.executeData,
						false,
						{},
						that.contextNodeName,
					);
				}

				return returnValue;
			},
		});
	}

	private getNodeExecutionOrPinnedData({
		nodeName,
		branchIndex,
		runIndex,
		shortSyntax = false,
	}: {
		nodeName: string;
		branchIndex?: number;
		runIndex?: number;
		shortSyntax?: boolean;
	}) {
		try {
			return this.getNodeExecutionData(nodeName, shortSyntax, branchIndex, runIndex);
		} catch (e) {
			const pinData = getPinDataIfManualExecution(this.workflow, nodeName, this.mode);
			if (pinData) {
				return pinData;
			}

			throw e;
		}
	}

	/**
	 * Returns the node ExecutionData
	 *
	 * @private
	 * @param {string} nodeName The name of the node query data from
	 * @param {boolean} [shortSyntax=false] If short syntax got used
	 * @param {number} [outputIndex] The index of the output, if not given the first one gets used
	 * @param {number} [runIndex] The index of the run, if not given the current one does get used
	 */
	private getNodeExecutionData(
		nodeName: string,
		shortSyntax = false,
		outputIndex?: number,
		runIndex?: number,
	): INodeExecutionData[] {
		const that = this;

		let executionData: INodeExecutionData[];
		if (!shortSyntax) {
			// Long syntax got used to return data from node in path

			if (that.runExecutionData === null) {
				throw new ExpressionError(
					"The workflow hasn't been executed yet, so you can't reference any output data",
					{
						runIndex: that.runIndex,
						itemIndex: that.itemIndex,
					},
				);
			}

			if (!that.workflow.getNode(nodeName)) {
				throw new ExpressionError("Referenced node doesn't exist", {
					runIndex: that.runIndex,
					itemIndex: that.itemIndex,
					nodeCause: nodeName,
					descriptionKey: 'nodeNotFound',
				});
			}

			if (
				!that.runExecutionData.resultData.runData.hasOwnProperty(nodeName) &&
				!getPinDataIfManualExecution(that.workflow, nodeName, that.mode)
			) {
				throw new ExpressionError('Referenced node is unexecuted', {
					runIndex: that.runIndex,
					itemIndex: that.itemIndex,
					type: 'no_node_execution_data',
					descriptionKey: 'noNodeExecutionData',
					nodeCause: nodeName,
				});
			}

			runIndex = runIndex === undefined ? that.defaultReturnRunIndex : runIndex;
			runIndex =
				runIndex === -1 ? that.runExecutionData.resultData.runData[nodeName].length - 1 : runIndex;

			if (that.runExecutionData.resultData.runData[nodeName].length <= runIndex) {
				throw new ExpressionError(`Run ${runIndex} of node "${nodeName}" not found`, {
					runIndex: that.runIndex,
					itemIndex: that.itemIndex,
				});
			}

			const taskData = that.runExecutionData.resultData.runData[nodeName][runIndex].data!;

			if (!taskData.main?.length || taskData.main[0] === null) {
				// throw new ApplicationError('No data found for item-index', { extra: { itemIndex } });
				throw new ExpressionError('No data found from `main` input', {
					runIndex: that.runIndex,
					itemIndex: that.itemIndex,
				});
			}

			// Check from which output to read the data.
			// Depends on how the nodes are connected.
			// (example "IF" node. If node is connected to "true" or to "false" output)
			if (outputIndex === undefined) {
				const nodeConnection = that.workflow.getNodeConnectionIndexes(
					that.contextNodeName,
					nodeName,
					NodeConnectionTypes.Main,
				);

				if (nodeConnection === undefined) {
					throw new ExpressionError(`connect "${that.contextNodeName}" to "${nodeName}"`, {
						runIndex: that.runIndex,
						itemIndex: that.itemIndex,
					});
				}
				outputIndex = nodeConnection.sourceIndex;
			}

			if (outputIndex === undefined) {
				outputIndex = 0;
			}

			if (taskData.main.length <= outputIndex) {
				throw new ExpressionError(`Node "${nodeName}" has no branch with index ${outputIndex}.`, {
					runIndex: that.runIndex,
					itemIndex: that.itemIndex,
				});
			}

			executionData = taskData.main[outputIndex] as INodeExecutionData[];
		} else {
			// Short syntax got used to return data from active node
			executionData = that.connectionInputData;
		}

		return executionData;
	}

	/**
	 * Returns a proxy which allows to query data of a given node
	 *
	 * @private
	 * @param {string} nodeName The name of the node query data from
	 * @param {boolean} [shortSyntax=false] If short syntax got used
	 * @param {boolean} [throwOnMissingExecutionData=true] If an error should get thrown if no execution data is available
	 */
	private nodeDataGetter(
		nodeName: string,
		shortSyntax = false,
		throwOnMissingExecutionData = true,
	) {
		const that = this;
		const node = this.workflow.nodes[nodeName];

		return new Proxy(
			{ binary: undefined, data: undefined, json: undefined },
			{
				has: () => true,
				get(target, name, receiver) {
					if (name === 'isProxy') return true;
					name = name.toString();

					if (!node) {
						throw new ExpressionError("Referenced node doesn't exist", {
							runIndex: that.runIndex,
							itemIndex: that.itemIndex,
							nodeCause: nodeName,
							descriptionKey: 'nodeNotFound',
						});
					}

					if (['binary', 'data', 'json'].includes(name)) {
						const executionData = that.getNodeExecutionOrPinnedData({
							nodeName,
							shortSyntax,
						});

						if (executionData.length === 0 && !throwOnMissingExecutionData) {
							return undefined;
						}

						if (executionData.length === 0) {
							if (that.workflow.getParentNodes(nodeName).length === 0) {
								throw new ExpressionError('No execution data available', {
									messageTemplate:
										'No execution data available to expression under ‘%%PARAMETER%%’',
									descriptionKey: 'noInputConnection',
									nodeCause: nodeName,
									runIndex: that.runIndex,
									itemIndex: that.itemIndex,
									type: 'no_input_connection',
								});
							}

							throw new ExpressionError('No execution data available', {
								runIndex: that.runIndex,
								itemIndex: that.itemIndex,
								type: 'no_execution_data',
							});
						}

						if (executionData.length <= that.itemIndex) {
							throw new ExpressionError(`No data found for item-index: "${that.itemIndex}"`, {
								runIndex: that.runIndex,
								itemIndex: that.itemIndex,
							});
						}

						if (['data', 'json'].includes(name)) {
							// JSON-Data
							return executionData[that.itemIndex].json;
						}
						if (name === 'binary') {
							// Binary-Data
							const returnData: IDataObject = {};

							if (!executionData[that.itemIndex].binary) {
								return returnData;
							}

							const binaryKeyData = executionData[that.itemIndex].binary!;
							for (const keyName of Object.keys(binaryKeyData)) {
								returnData[keyName] = {};

								const binaryData = binaryKeyData[keyName];
								for (const propertyName in binaryData) {
									if (propertyName === 'data') {
										// Skip the data property

										continue;
									}
									(returnData[keyName] as IDataObject)[propertyName] = binaryData[propertyName];
								}
							}

							return returnData;
						}
					} else if (name === 'context') {
						return that.nodeContextGetter(nodeName);
					} else if (name === 'parameter') {
						// Get node parameter data
						return that.nodeParameterGetter(nodeName);
					} else if (name === 'runIndex') {
						if (!that.runExecutionData?.resultData.runData[nodeName]) {
							return -1;
						}
						return that.runExecutionData.resultData.runData[nodeName].length - 1;
					}

					return Reflect.get(target, name, receiver);
				},
			},
		);
	}

	private prevNodeGetter() {
		const allowedValues = ['name', 'outputIndex', 'runIndex'];
		const that = this;

		return new Proxy(
			{},
			{
				has: () => true,
				ownKeys() {
					return allowedValues;
				},
				getOwnPropertyDescriptor() {
					return {
						enumerable: true,
						configurable: true,
					};
				},
				get(target, name, receiver) {
					if (name === 'isProxy') return true;

					if (!that.executeData?.source) {
						// Means the previous node did not get executed yet
						return undefined;
					}

					const sourceData: ISourceData = that.executeData.source.main[0] as ISourceData;

					if (name === 'name') {
						return sourceData.previousNode;
					}
					if (name === 'outputIndex') {
						return sourceData.previousNodeOutput || 0;
					}
					if (name === 'runIndex') {
						return sourceData.previousNodeRun || 0;
					}

					return Reflect.get(target, name, receiver);
				},
			},
		);
	}

	/**
	 * Returns a proxy to query data from the workflow
	 *
	 * @private
	 */
	private workflowGetter() {
		const allowedValues = ['active', 'id', 'name'];
		const that = this;

		return new Proxy(
			{},
			{
				has: () => true,
				ownKeys() {
					return allowedValues;
				},
				getOwnPropertyDescriptor() {
					return {
						enumerable: true,
						configurable: true,
					};
				},
				get(target, name, receiver) {
					if (name === 'isProxy') return true;

					if (allowedValues.includes(name.toString())) {
						const value = that.workflow[name as keyof typeof target];

						if (value === undefined && name === 'id') {
							throw new ExpressionError('save workflow to view', {
								description: 'Please save the workflow first to use $workflow',
								runIndex: that.runIndex,
								itemIndex: that.itemIndex,
							});
						}

						return value;
					}

					return Reflect.get(target, name, receiver);
				},
			},
		);
	}

	/**
	 * Returns a proxy to query data of all nodes
	 *
	 * @private
	 */
	private nodeGetter() {
		const that = this;
		return new Proxy(
			{},
			{
				has: () => true,
				get(_, name) {
					if (name === 'isProxy') return true;

					const nodeName = name.toString();

					if (that.workflow.getNode(nodeName) === null) {
						throw new ExpressionError("Referenced node doesn't exist", {
							runIndex: that.runIndex,
							itemIndex: that.itemIndex,
							nodeCause: nodeName,
							descriptionKey: 'nodeNotFound',
						});
					}

					return that.nodeDataGetter(nodeName);
				},
			},
		);
	}

	/**
	 * Returns the data proxy object which allows to query data from current run
	 *
	 */
	getDataProxy(opts?: { throwOnMissingExecutionData: boolean }): IWorkflowDataProxyData {
		const that = this;

		// replacing proxies with the actual data.
		const jmespathWrapper = (data: IDataObject | IDataObject[], query: string) => {
			if (typeof data !== 'object' || typeof query !== 'string') {
				throw new ExpressionError('expected two arguments (Object, string) for this function', {
					runIndex: that.runIndex,
					itemIndex: that.itemIndex,
				});
			}

			if (!Array.isArray(data) && typeof data === 'object') {
				return jmespath.search({ ...data }, query);
			}
			return jmespath.search(data, query);
		};

		const createExpressionError = (
			message: string,
			context?: ExpressionErrorOptions & {
				moreInfoLink?: boolean;
				functionOverrides?: {
					// Custom data to display for Function-Nodes
					message?: string;
					description?: string;
				};
			},
		) => {
			if (isScriptingNode(that.activeNodeName, that.workflow) && context?.functionOverrides) {
				// If the node in which the error is thrown is a function node,
				// display a different error message in case there is one defined
				message = context.functionOverrides.message || message;
				context.description = context.functionOverrides.description || context.description;
				// The error will be in the code and not on an expression on a parameter
				// so remove the messageTemplate as it would overwrite the message
				context.messageTemplate = undefined;
			}

			if (context?.nodeCause) {
				const nodeName = context.nodeCause;
				const pinData = getPinDataIfManualExecution(that.workflow, nodeName, that.mode);

				if (pinData) {
					if (!context) {
						context = {};
					}
					message = `Unpin '${nodeName}' to execute`;
					context.messageTemplate = undefined;
					context.descriptionKey = 'pairedItemPinned';
				}

				if (context.moreInfoLink && (pinData || isScriptingNode(nodeName, that.workflow))) {
					const moreInfoLink =
						' <a target="_blank" href="https://docs.n8n.io/data/data-mapping/data-item-linking/item-linking-errors/">More info</a>';

					context.description += moreInfoLink;
					if (context.descriptionTemplate) context.descriptionTemplate += moreInfoLink;
				}
			}

			return new ExpressionError(message, {
				runIndex: that.runIndex,
				itemIndex: that.itemIndex,
				...context,
			});
		};

		const createInvalidPairedItemError = ({ nodeName }: { nodeName: string }) => {
			return createExpressionError("Can't get data for expression", {
				messageTemplate: 'Expression info invalid',
				functionality: 'pairedItem',
				functionOverrides: {
					message: "Can't get data",
				},
				nodeCause: nodeName,
				descriptionKey: 'pairedItemInvalidInfo',
				type: 'paired_item_invalid_info',
			});
		};

		const createMissingPairedItemError = (
			nodeCause: string,
			usedMethodName: 'itemMatching' | 'pairedItem' | 'item' | '$getPairedItem' = 'pairedItem',
		) => {
			const message = `Using the ${usedMethodName} method doesn't work with pinned data in this scenario. Please unpin '${nodeCause}' and try again.`;
			return new ExpressionError(message, {
				runIndex: that.runIndex,
				itemIndex: that.itemIndex,
				functionality: 'pairedItem',
				descriptionKey: isScriptingNode(nodeCause, that.workflow)
					? 'pairedItemNoInfoCodeNode'
					: 'pairedItemNoInfo',
				nodeCause,
				causeDetailed: `Missing pairedItem data (node '${nodeCause}' probably didn't supply it)`,
				type: 'paired_item_no_info',
			});
		};

		const createNoConnectionError = (nodeCause: string) => {
			return createExpressionError('Invalid expression', {
				messageTemplate: 'No path back to referenced node',
				functionality: 'pairedItem',
				descriptionKey: isScriptingNode(nodeCause, that.workflow)
					? 'pairedItemNoConnectionCodeNode'
					: 'pairedItemNoConnection',
				type: 'paired_item_no_connection',
				moreInfoLink: true,
				nodeCause,
			});
		};

		// eslint-disable-next-line complexity
		const getPairedItem = (
			destinationNodeName: string,
			incomingSourceData: ISourceData | null,
			pairedItem: IPairedItemData,
			usedMethodName: 'pairedItem' | 'itemMatching' | 'item' | '$getPairedItem' = '$getPairedItem',
		): INodeExecutionData | null => {
			let taskData: ITaskData | undefined;

			let sourceData: ISourceData | null = incomingSourceData;

			if (pairedItem.sourceOverwrite) {
				sourceData = pairedItem.sourceOverwrite;
			}

			if (typeof pairedItem === 'number') {
				pairedItem = {
					item: pairedItem,
				};
			}

			let currentPairedItem = pairedItem;

			let nodeBeforeLast: string | undefined;

			while (sourceData !== null && destinationNodeName !== sourceData.previousNode) {
				const runIndex = sourceData?.previousNodeRun || 0;
				const previousNodeOutput = sourceData.previousNodeOutput || 0;
				taskData =
					that.runExecutionData?.resultData?.runData?.[sourceData.previousNode]?.[runIndex];

				if (taskData?.data?.main && previousNodeOutput >= taskData.data.main.length) {
					throw createExpressionError('Can’t get data for expression', {
						messageTemplate: 'Can’t get data for expression under ‘%%PARAMETER%%’ field',
						functionOverrides: {
							message: 'Can’t get data',
						},
						nodeCause: nodeBeforeLast,
						description: 'Apologies, this is an internal error. See details for more information',
						causeDetailed: 'Referencing a non-existent output on a node, problem with source data',
						type: 'internal',
					});
				}

				const previousNodeOutputData =
					taskData?.data?.main?.[previousNodeOutput] ??
					getPinDataIfManualExecution(that.workflow, sourceData.previousNode, that.mode) ??
					[];
				const source = taskData?.source ?? [];

				if (pairedItem.item >= previousNodeOutputData.length) {
					throw createInvalidPairedItemError({
						nodeName: sourceData.previousNode,
					});
				}

				const itemPreviousNode: INodeExecutionData = previousNodeOutputData[pairedItem.item];

				if (itemPreviousNode.pairedItem === undefined) {
					throw createMissingPairedItemError(sourceData.previousNode, usedMethodName);
				}

				if (Array.isArray(itemPreviousNode.pairedItem)) {
					// Item is based on multiple items so check all of them
					const results = itemPreviousNode.pairedItem

						.map((item) => {
							try {
								const itemInput = item.input || 0;
								if (itemInput >= source.length) {
									// `Could not resolve pairedItem as the defined node input '${itemInput}' does not exist on node '${sourceData!.previousNode}'.`
									// Actual error does not matter as it gets caught below and `null` will be returned
									throw new ApplicationError('Not found');
								}

								return getPairedItem(destinationNodeName, source[itemInput], item, usedMethodName);
							} catch (error) {
								// Means pairedItem could not be found
								return null;
							}
						})
						.filter((result) => result !== null);

					if (results.length !== 1) {
						// Check if the results are all the same
						const firstResult = results[0];
						if (results.every((result) => result === firstResult)) {
							// All results are the same so return the first one
							return firstResult;
						}

						throw createExpressionError('Invalid expression', {
							messageTemplate: `Multiple matching items for expression [item ${
								currentPairedItem.item || 0
							}]`,
							functionality: 'pairedItem',
							functionOverrides: {
								message: `Multiple matching items for code [item ${currentPairedItem.item || 0}]`,
							},
							nodeCause: destinationNodeName,
							descriptionKey: isScriptingNode(destinationNodeName, that.workflow)
								? 'pairedItemMultipleMatchesCodeNode'
								: 'pairedItemMultipleMatches',
							type: 'paired_item_multiple_matches',
						});
					}

					return results[0];
				}

				currentPairedItem = pairedItem;

				// pairedItem is not an array
				if (typeof itemPreviousNode.pairedItem === 'number') {
					pairedItem = {
						item: itemPreviousNode.pairedItem,
					};
				} else {
					pairedItem = itemPreviousNode.pairedItem;
				}

				const itemInput = pairedItem.input || 0;
				if (itemInput >= source.length) {
					if (source.length === 0) {
						// A trigger node got reached, so looks like that that item can not be resolved
						throw createNoConnectionError(destinationNodeName);
					}

					throw createExpressionError('Can’t get data for expression', {
						messageTemplate: 'Can’t get data for expression under ‘%%PARAMETER%%’ field',
						functionality: 'pairedItem',
						functionOverrides: {
							message: 'Can’t get data',
						},
						nodeCause: nodeBeforeLast,
						description: `In node ‘<strong>${sourceData.previousNode}</strong>’, output item ${
							currentPairedItem.item || 0
						} of ${
							sourceData.previousNodeRun
								? `of run ${(sourceData.previousNodeRun || 0).toString()} `
								: ''
						}points to a branch that doesn’t exist.`,
						type: 'paired_item_invalid_info',
					});
				}

				nodeBeforeLast = sourceData.previousNode;
				sourceData = source[pairedItem.input || 0] || null;

				if (pairedItem.sourceOverwrite) {
					sourceData = pairedItem.sourceOverwrite;
				}
			}

			if (sourceData === null) {
				throw createExpressionError('Can’t get data for expression', {
					messageTemplate: 'Can’t get data for expression under ‘%%PARAMETER%%’ field',
					functionality: 'pairedItem',
					functionOverrides: {
						message: 'Can’t get data',
					},
					nodeCause: nodeBeforeLast,
					description: 'Could not resolve, probably no pairedItem exists',
					type: 'paired_item_no_info',
					moreInfoLink: true,
				});
			}

			taskData =
				that.runExecutionData!.resultData.runData[sourceData.previousNode]?.[
					sourceData?.previousNodeRun || 0
				];

			if (!taskData) {
				const pinData = getPinDataIfManualExecution(
					that.workflow,
					sourceData.previousNode,
					that.mode,
				);

				if (pinData) {
					taskData = { data: { main: [pinData] }, startTime: 0, executionTime: 0, source: [] };
				}
			}

			const previousNodeOutput = sourceData.previousNodeOutput || 0;
			if (previousNodeOutput >= taskData.data!.main.length) {
				throw createExpressionError('Can’t get data for expression', {
					messageTemplate: 'Can’t get data for expression under ‘%%PARAMETER%%’ field',
					functionality: 'pairedItem',
					functionOverrides: {
						message: 'Can’t get data',
					},
					nodeCause: sourceData.previousNode,
					description: 'Item points to a node output which does not exist',
					causeDetailed: `The sourceData points to a node output ‘${previousNodeOutput}‘ which does not exist on node ‘${sourceData.previousNode}‘ (output node did probably supply a wrong one)`,
					type: 'paired_item_invalid_info',
				});
			}

			if (pairedItem.item >= taskData.data!.main[previousNodeOutput]!.length) {
				throw createInvalidPairedItemError({
					nodeName: sourceData.previousNode,
				});
			}

			return taskData.data!.main[previousNodeOutput]![pairedItem.item];
		};

		const handleFromAi = (
			name: string,
			_description?: string,
			_type: string = 'string',
			defaultValue?: unknown,
		) => {
			const { itemIndex, runIndex } = that;
			if (!name || name === '') {
				throw new ExpressionError("Add a key, e.g. $fromAI('placeholder_name')", {
					runIndex,
					itemIndex,
				});
			}
			const nameValidationRegex = /^[a-zA-Z0-9_-]{0,64}$/;
			if (!nameValidationRegex.test(name)) {
				throw new ExpressionError(
					'Invalid parameter key, must be between 1 and 64 characters long and only contain lowercase letters, uppercase letters, numbers, underscores, and hyphens',
					{
						runIndex,
						itemIndex,
					},
				);
			}
			const inputData =
				that.runExecutionData?.resultData.runData[that.activeNodeName]?.[runIndex].inputOverride;
			const placeholdersDataInputData =
				inputData?.[NodeConnectionTypes.AiTool]?.[0]?.[itemIndex].json;

			if (Boolean(!placeholdersDataInputData)) {
				throw new ExpressionError('No execution data available', {
					runIndex,
					itemIndex,
					type: 'no_execution_data',
				});
			}
			return (
				// TS does not know that the key exists, we need to address this in refactor
				(placeholdersDataInputData?.query as Record<string, unknown>)?.[name] ??
				placeholdersDataInputData?.[name] ??
				defaultValue
			);
		};

		const base = {
			$: (nodeName: string) => {
				if (!nodeName) {
					throw createExpressionError('When calling $(), please specify a node');
				}

				const referencedNode = that.workflow.getNode(nodeName);
				if (referencedNode === null) {
					throw createExpressionError("Referenced node doesn't exist", {
						runIndex: that.runIndex,
						itemIndex: that.itemIndex,
						nodeCause: nodeName,
						descriptionKey: 'nodeNotFound',
					});
				}

				const ensureNodeExecutionData = () => {
					if (
						!that?.runExecutionData?.resultData?.runData.hasOwnProperty(nodeName) &&
						!getPinDataIfManualExecution(that.workflow, nodeName, that.mode)
					) {
						throw createExpressionError('Referenced node is unexecuted', {
							runIndex: that.runIndex,
							itemIndex: that.itemIndex,
							type: 'no_node_execution_data',
							descriptionKey: 'noNodeExecutionData',
							nodeCause: nodeName,
						});
					}
				};

				return new Proxy(
					{},
					{
						has: () => true,
						ownKeys() {
							return [
								'pairedItem',
								'isExecuted',
								'itemMatching',
								'item',
								'first',
								'last',
								'all',
								'context',
								'params',
							];
						},
						get(target, property, receiver) {
							if (property === 'isProxy') return true;

							if (property === 'isExecuted') {
								return (
									that?.runExecutionData?.resultData?.runData.hasOwnProperty(nodeName) ?? false
								);
							}

							if (property === 'pairedItem' || property === 'itemMatching' || property === 'item') {
								// Before resolving the pairedItem make sure that the requested node comes in the
								// graph before the current one
								const activeNode = that.workflow.getNode(that.activeNodeName);

								let contextNode = that.contextNodeName;
								if (activeNode) {
									const parentMainInputNode = that.workflow.getParentMainInputNode(activeNode);
									contextNode = parentMainInputNode.name ?? contextNode;
								}
								const parentNodes = that.workflow.getParentNodes(contextNode);
								if (!parentNodes.includes(nodeName)) {
									throw createNoConnectionError(nodeName);
								}

								ensureNodeExecutionData();

								const pairedItemMethod = (itemIndex?: number) => {
									if (itemIndex === undefined) {
										if (property === 'itemMatching') {
											throw createExpressionError('Missing item index for .itemMatching()', {
												itemIndex,
											});
										}
										itemIndex = that.itemIndex;
									}

									if (!that.connectionInputData.length) {
										const pinnedData = getPinDataIfManualExecution(
											that.workflow,
											nodeName,
											that.mode,
										);

										if (pinnedData) {
											return pinnedData[itemIndex];
										}
									}

									const executionData = that.connectionInputData;
									const input = executionData?.[itemIndex];
									if (!input) {
										throw createExpressionError('Can’t get data for expression', {
											messageTemplate: 'Can’t get data for expression under ‘%%PARAMETER%%’ field',
											functionality: 'pairedItem',
											functionOverrides: {
												description: `Some intermediate nodes between ‘<strong>${nodeName}</strong>‘ and  ‘<strong>${that.activeNodeName}</strong>‘ have not executed yet.`,
												message: 'Can’t get data',
											},
											description: `Some intermediate nodes between ‘<strong>${nodeName}</strong>‘ and  ‘<strong>${that.activeNodeName}</strong>‘ have not executed yet.`,
											causeDetailed: `pairedItem can\'t be found when intermediate nodes between ‘<strong>${nodeName}</strong>‘ and  ‘<strong>${that.activeNodeName}</strong> have not executed yet.`,
											itemIndex,
											type: 'paired_item_intermediate_nodes',
										});
									}

									// As we operate on the incoming item we can be sure that pairedItem is not an
									// array. After all can it only come from exactly one previous node via a certain
									// input. For that reason do we not have to consider the array case.
									const pairedItem = input.pairedItem as IPairedItemData;

									if (pairedItem === undefined) {
										throw createMissingPairedItemError(that.activeNodeName, property);
									}

									if (!that.executeData?.source) {
										throw createExpressionError('Can’t get data for expression', {
											messageTemplate: 'Can’t get data for expression under ‘%%PARAMETER%%’ field',
											functionality: 'pairedItem',
											functionOverrides: {
												message: 'Can’t get data',
											},
											description:
												'Apologies, this is an internal error. See details for more information',
											causeDetailed: 'Missing sourceData (probably an internal error)',
											itemIndex,
										});
									}

									const sourceData: ISourceData | null =
										that.executeData.source.main[pairedItem.input || 0] ??
										that.executeData.source.main[0];

									return getPairedItem(nodeName, sourceData, pairedItem, property);
								};

								if (property === 'item') {
									return pairedItemMethod();
								}
								return pairedItemMethod;
							}

							if (property === 'first') {
								ensureNodeExecutionData();
								return (branchIndex?: number, runIndex?: number) => {
									branchIndex =
										branchIndex ??
										// default to the output the active node is connected to
										that.workflow.getNodeConnectionIndexes(that.activeNodeName, nodeName)
											?.sourceIndex ??
										0;
									const executionData = that.getNodeExecutionOrPinnedData({
										nodeName,
										branchIndex,
										runIndex,
									});
									if (executionData[0]) return executionData[0];
									return undefined;
								};
							}
							if (property === 'last') {
								ensureNodeExecutionData();
								return (branchIndex?: number, runIndex?: number) => {
									branchIndex =
										branchIndex ??
										// default to the output the active node is connected to
										that.workflow.getNodeConnectionIndexes(that.activeNodeName, nodeName)
											?.sourceIndex ??
										0;
									const executionData = that.getNodeExecutionOrPinnedData({
										nodeName,
										branchIndex,
										runIndex,
									});
									if (!executionData.length) return undefined;
									if (executionData[executionData.length - 1]) {
										return executionData[executionData.length - 1];
									}
									return undefined;
								};
							}
							if (property === 'all') {
								ensureNodeExecutionData();
								return (branchIndex?: number, runIndex?: number) => {
									branchIndex =
										branchIndex ??
										// default to the output the active node is connected to
										that.workflow.getNodeConnectionIndexes(that.activeNodeName, nodeName)
											?.sourceIndex ??
										0;
									return that.getNodeExecutionOrPinnedData({ nodeName, branchIndex, runIndex });
								};
							}
							if (property === 'context') {
								return that.nodeContextGetter(nodeName);
							}
							if (property === 'params') {
								return that.workflow.getNode(nodeName)?.parameters;
							}
							return Reflect.get(target, property, receiver);
						},
					},
				);
			},

			$input: new Proxy({} as ProxyInput, {
				has: () => true,
				ownKeys() {
					return ['all', 'context', 'first', 'item', 'last', 'params'];
				},
				getOwnPropertyDescriptor() {
					return {
						enumerable: true,
						configurable: true,
					};
				},
				get(target, property, receiver) {
					if (property === 'isProxy') return true;

					if (that.connectionInputData.length === 0) {
						throw createExpressionError('No execution data available', {
							runIndex: that.runIndex,
							itemIndex: that.itemIndex,
							type: 'no_execution_data',
						});
					}

					if (property === 'item') {
						return that.connectionInputData[that.itemIndex];
					}
					if (property === 'first') {
						return (...args: unknown[]) => {
							if (args.length) {
								throw createExpressionError('$input.first() should have no arguments');
							}

							const result = that.connectionInputData;
							if (result[0]) {
								return result[0];
							}
							return undefined;
						};
					}
					if (property === 'last') {
						return (...args: unknown[]) => {
							if (args.length) {
								throw createExpressionError('$input.last() should have no arguments');
							}

							const result = that.connectionInputData;
							if (result.length && result[result.length - 1]) {
								return result[result.length - 1];
							}
							return undefined;
						};
					}
					if (property === 'all') {
						return () => {
							const result = that.connectionInputData;
							if (result.length) {
								return result;
							}
							return [];
						};
					}

					if (['context', 'params'].includes(property as string)) {
						// For the following properties we need the source data so fail in case it is missing
						// for some reason (even though that should actually never happen)
						if (!that.executeData?.source) {
							throw createExpressionError('Can’t get data for expression', {
								messageTemplate: 'Can’t get data for expression under ‘%%PARAMETER%%’ field',
								functionOverrides: {
									message: 'Can’t get data',
								},
								description:
									'Apologies, this is an internal error. See details for more information',
								causeDetailed: 'Missing sourceData (probably an internal error)',
								runIndex: that.runIndex,
							});
						}

						const sourceData: ISourceData = that.executeData.source.main[0] as ISourceData;

						if (property === 'context') {
							return that.nodeContextGetter(sourceData.previousNode);
						}
						if (property === 'params') {
							return that.workflow.getNode(sourceData.previousNode)?.parameters;
						}
					}

					return Reflect.get(target, property, receiver);
				},
			}),

			$binary: {}, // Placeholder
			$data: {}, // Placeholder
			$env: createEnvProvider(
				that.runIndex,
				that.itemIndex,
				that.envProviderState ?? createEnvProviderState(),
			),
			$evaluateExpression: (expression: string, itemIndex?: number) => {
				itemIndex = itemIndex || that.itemIndex;
				return that.workflow.expression.getParameterValue(
					`=${expression}`,
					that.runExecutionData,
					that.runIndex,
					itemIndex,
					that.activeNodeName,
					that.connectionInputData,
					that.mode,
					that.additionalKeys,
					that.executeData,
					false,
					{},
					that.contextNodeName,
				);
			},
			$item: (itemIndex: number, runIndex?: number) => {
				const defaultReturnRunIndex = runIndex === undefined ? -1 : runIndex;
				const dataProxy = new WorkflowDataProxy(
					this.workflow,
					this.runExecutionData,
					this.runIndex,
					itemIndex,
					this.activeNodeName,
					this.connectionInputData,
					that.siblingParameters,
					that.mode,
					that.additionalKeys,
					that.executeData,
					defaultReturnRunIndex,
					{},
					that.contextNodeName,
				);
				return dataProxy.getDataProxy();
			},
			$fromAI: handleFromAi,
			// Make sure mis-capitalized $fromAI is handled correctly even though we don't auto-complete it
			$fromai: handleFromAi,
			$fromAi: handleFromAi,
			$items: (nodeName?: string, outputIndex?: number, runIndex?: number) => {
				if (nodeName === undefined) {
					nodeName = (that.prevNodeGetter() as { name: string }).name;
					const node = this.workflow.nodes[nodeName];
					let result = that.connectionInputData;
					if (node.executeOnce === true) {
						result = result.slice(0, 1);
					}
					if (result.length) {
						return result;
					}
					return [];
				}

				outputIndex = outputIndex || 0;
				runIndex = runIndex === undefined ? -1 : runIndex;

				return that.getNodeExecutionData(nodeName, false, outputIndex, runIndex);
			},
			$json: {}, // Placeholder
			$node: this.nodeGetter(),
			$self: this.selfGetter(),
			$parameter: this.nodeParameterGetter(this.activeNodeName),
			$rawParameter: this.nodeParameterGetter(this.activeNodeName, false),
			$prevNode: this.prevNodeGetter(),
			$runIndex: this.runIndex,
			$mode: this.mode,
			$workflow: this.workflowGetter(),
			$itemIndex: this.itemIndex,
			$now: DateTime.now(),
			$today: DateTime.now().set({ hour: 0, minute: 0, second: 0, millisecond: 0 }),
			$jmesPath: jmespathWrapper,

			DateTime,

			Interval,

			Duration,
			...that.additionalKeys,
			$getPairedItem: getPairedItem,

			// deprecated
			$jmespath: jmespathWrapper,
			$position: this.itemIndex,
			$thisItem: that.connectionInputData[that.itemIndex],
			$thisItemIndex: this.itemIndex,
			$thisRunIndex: this.runIndex,
			$nodeVersion: that.workflow.getNode(that.activeNodeName)?.typeVersion,
			$nodeId: that.workflow.getNode(that.activeNodeName)?.id,
			$webhookId: that.workflow.getNode(that.activeNodeName)?.webhookId,
		};
		const throwOnMissingExecutionData = opts?.throwOnMissingExecutionData ?? true;

		return new Proxy(base, {
			has: () => true,
			get(target, name, receiver) {
				if (name === 'isProxy') return true;

				if (['$data', '$json'].includes(name as string)) {
					return that.nodeDataGetter(that.contextNodeName, true, throwOnMissingExecutionData)?.json;
				}
				if (name === '$binary') {
					return that.nodeDataGetter(that.contextNodeName, true, throwOnMissingExecutionData)
						?.binary;
				}

				return Reflect.get(target, name, receiver);
			},
		});
	}
}
