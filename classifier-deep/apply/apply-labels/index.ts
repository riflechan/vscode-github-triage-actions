/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as mongodb from 'mongodb'
import { readFileSync } from 'fs'
import { join } from 'path'
import { context } from '@actions/github'
import { OctoKit, OctoKitIssue } from '../../../api/octokit'
import { getRequiredInput, getInput, safeLog } from '../../../common/utils'
import { Action } from '../../../common/Action'
import { trackEvent } from '../../../common/telemetry'

const token = getRequiredInput('token')
const manifestDbConnectionString = getInput('manifestDbConnectionString')

const allowLabels = (getInput('allowLabels') || '').split('|')
const debug = !!getInput('__debug')

type ClassifierConfig = {
	vacation?: string[]
	labels?: {
		[area: string]: { accuracy?: number; assign?: [string] }
	}
	assignees?: {
		[assignee: string]: { accuracy?: number }
	}
}

type Labeling = { confident: boolean; category: string; confidence: number }
type LabelingsFile = { number: number; area: Labeling; assignee: Labeling }[]

type Triager = {
	id: string
	triager: boolean
}

class ApplyLabels extends Action {
	id = 'Classifier-Deep/Apply/ApplyLabels'

	async onTriggered(github: OctoKit) {
		let manifest: Promise<string[] | undefined> = Promise.resolve(undefined)

		if (manifestDbConnectionString) {
			safeLog('has manifestDbConnectionString')
			manifest = mongodb.MongoClient.connect(manifestDbConnectionString).then(async (db) => {
				safeLog('connected to db')
				try {
					const collection = db.collection('testers')
					const triagers = await collection.find<Triager>().toArray()
					return triagers.filter((t) => t.triager).map((t) => t.id)
				} catch (e) {
					safeLog('error reading from db')
					safeLog((e as any).message)
				} finally {
					safeLog('disconnected from db')
					// eslint-disable-next-line @typescript-eslint/no-floating-promises
					db.close()
				}
			})
		} else {
			safeLog('has no manifestDbConnectionString')
		}

		const config: ClassifierConfig = await github.readConfig(getRequiredInput('configPath'))
		const labelings: LabelingsFile = JSON.parse(
			readFileSync(join(__dirname, '../issue_labels.json'), { encoding: 'utf8' }),
		)

		for (const labeling of labelings) {
			const issue = new OctoKitIssue(token, context.repo, { number: labeling.number })

			const potentialAssignees: string[] = []
			const addAssignee = async (assignee: string) => {
				if (config.vacation?.includes(assignee)) {
					safeLog('not assigning ', assignee, 'becuase they are on vacation')
				} else {
					potentialAssignees.push(assignee)
				}
			}

			const issueData = await issue.getIssue()

			if (issueData.number !== labeling.number) {
				safeLog(`issue ${labeling.number} moved to ${issueData.number}, skipping`)
				continue
			}

			if (
				!debug &&
				(issueData.assignee || issueData.labels.some((label) => !allowLabels.includes(label)))
			) {
				safeLog('skipping')
				continue
			}

			safeLog(
				'not skipping',
				JSON.stringify({
					assignee: labeling.assignee,
					area: labeling.area,
					number: labeling.number,
				}),
			)

			{
				const { category, confidence, confident } = labeling.area
				if (debug) {
					if (confident) {
						if (!(await github.repoHasLabel(category))) {
							safeLog(`creating label`)
							await github.createLabel(category, 'f1d9ff', '')
						}
						await issue.addLabel(category)
					}
					await issue.postComment(
						`confidence for label ${category}: ${confidence}. ${
							confident ? 'does' : 'does not'
						} meet threshold`,
					)
				}

				if (confident) {
					safeLog(`adding label ${category} to issue ${issueData.number}`)

					const labelConfig = config.labels?.[category]
					await Promise.all<any>([
						...(labelConfig?.assign
							? labelConfig.assign.map((assignee) => addAssignee(assignee))
							: []),
					])

					await trackEvent(issue, 'classification:performed', {
						label: labeling.area.category,
					})
				}
			}

			{
				const { category, confidence, confident } = labeling.assignee
				if (debug) {
					if (confident) {
						if (!(await github.repoHasLabel(category))) {
							safeLog(`creating assignee label`)
							await github.createLabel(category, 'ffa5a1', '')
						}
						await issue.addLabel(category)
					}
					await issue.postComment(
						`confidence for assignee ${category}: ${confidence}. ${
							confident ? 'does' : 'does not'
						} meet threshold`,
					)
				}

				if (confident) {
					safeLog('has assignee')
					await addAssignee(category)
					await trackEvent(issue, 'classification:performed', {
						assignee: labeling.assignee.category,
					})
				}
			}

			let performedAssignment = false
			if (potentialAssignees.length && !debug) {
				for (const assignee of potentialAssignees) {
					const hasBeenAssigned = await issue.getAssigner(assignee).catch(() => undefined)
					if (!hasBeenAssigned) {
						await issue.addAssignee(assignee)
						performedAssignment = true
						break
					}
				}
			}

			if (!performedAssignment) {
				safeLog('could not find assignee, picking a random one...')
				try {
					const available = await manifest
					if (available) {
						const randomSelection = available[Math.floor(Math.random() * available.length)]
						safeLog('assigning', randomSelection)
						if (!debug) {
							await issue.addLabel('triage-needed')
							await issue.addAssignee(randomSelection)
						}
					} else {
						safeLog('could not find manifest')
					}
				} catch (e) {
					safeLog('error assigning random', (e as any).message)
				}
			}
		}
	}
}

new ApplyLabels().run() // eslint-disable-line