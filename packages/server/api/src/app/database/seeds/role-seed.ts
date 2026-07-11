import { system } from '../../helper/system/system'
import { DataSeed } from './data-seed'

// TYRBO-PATCH: project roles were an EE feature backed by the project_role
// table, which was removed with packages/server/api/src/app/ee. Default
// roles are served statically from app/tyrbo/ce-defaults, so there is
// nothing to seed.
export const rolesSeed: DataSeed = {
    run: async () => {
        system.globalLogger().info({ name: 'rolesSeed' }, 'Skipping role seed: default project roles are static in this edition')
    },
}
