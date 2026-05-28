import {type SanityOrgUser, subdebug} from '@sanity/cli-core'
import {spinner} from '@sanity/cli-core/ux'
import {type DatasetAclMode} from '@sanity/client'

import {createDataset as createDatasetService} from '../../../services/datasets.js'
import {createOrganization, listOrganizations} from '../../../services/organizations.js'
import {createProject} from '../../../services/projects.js'
import {formatHint} from '../../../util/formatHint.js'
import {getOrganizationsWithAttachGrantInfo} from '../../organizations/getOrganizationsWithAttachGrantInfo.js'
import {InitError} from '../initError.js'
import {promptUserForOrganization} from './promptUserForOrganization.js'

const debug = subdebug('init')

export async function createProjectFromName({
  coupon,
  createProjectName,
  dataset,
  organization,
  planId,
  unattended,
  user,
  visibility,
}: {
  coupon: string | undefined
  createProjectName: string
  dataset: string | undefined
  organization: string | undefined
  planId: string | undefined
  unattended: boolean | undefined
  user: SanityOrgUser
  visibility: 'private' | 'public' | undefined
}): Promise<string> {
  debug('--project-name specified, creating a new project')

  let orgForCreateProjectFlag = organization

  if (!orgForCreateProjectFlag) {
    debug('no organization specified, selecting one')
    const organizations = await listOrganizations()

    if (unattended) {
      const withGrantInfo = await getOrganizationsWithAttachGrantInfo(organizations)
      const withAttach = withGrantInfo.filter(({hasAttachGrant}) => hasAttachGrant)
      if (withAttach.length === 0) {
        debug('no organizations found, auto-creating one in unattended mode')
        const newOrgName = user.name || 'Personal'
        const newOrg = await createOrganization(newOrgName)
        orgForCreateProjectFlag = newOrg.id
        debug('auto-created organization: %s (%s)', newOrg.id, newOrg.name)
      } else if (withAttach.length > 1) {
        const orgList = withAttach.map(({organization: o}) => `  ${o.id} (${o.name})`).join('\n')
        throw new InitError(
          `Multiple organizations available:\n${orgList}` +
            formatHint(
              `sanity init --organization ${withAttach[0].organization.id} --project-name "my-project" -y`,
            ),
          1,
        )
      } else {
        orgForCreateProjectFlag = withAttach[0].organization.id
        debug('unattended mode: single org with attach grant: %s', orgForCreateProjectFlag)
      }
    } else {
      orgForCreateProjectFlag = await promptUserForOrganization({
        organizations,
        user,
      })
    }
  }

  debug('creating a new project')
  const createdProject = await createProject({
    displayName: createProjectName.trim(),
    metadata: {coupon},
    organizationId: orgForCreateProjectFlag,
    subscription: planId ? {planId} : undefined,
  })

  debug('Project with ID %s created', createdProject.projectId)
  if (dataset) {
    debug('--dataset specified, creating dataset (%s)', dataset)
    const spin = spinner('Creating dataset').start()
    await createDatasetService({
      aclMode: visibility as DatasetAclMode | undefined,
      datasetName: dataset,
      projectId: createdProject.projectId,
    })
    spin.succeed()
  }

  return createdProject.projectId
}
