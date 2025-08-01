import { Knex } from "knex";

import { TDbClient } from "@app/db";
import {
  OrganizationsSchema,
  OrgMembershipRole,
  TableName,
  TOrganizations,
  TOrganizationsInsert,
  TOrgMemberships,
  TOrgMembershipsInsert,
  TOrgMembershipsUpdate,
  TUserEncryptionKeys
} from "@app/db/schemas";
import { DatabaseError } from "@app/lib/errors";
import {
  buildFindFilter,
  ormify,
  selectAllTableCols,
  sqlNestRelationships,
  TFindFilter,
  TFindOpt,
  withTransaction
} from "@app/lib/knex";
import { generateKnexQueryFromScim } from "@app/lib/knex/scim";

import { OrgAuthMethod } from "./org-types";

export type TOrgDALFactory = ReturnType<typeof orgDALFactory>;

export const orgDALFactory = (db: TDbClient) => {
  const orgOrm = ormify(db, TableName.Organization);

  const findOrganizationsByFilter = async ({
    limit,
    offset,
    searchTerm,
    sortBy
  }: {
    limit: number;
    offset: number;
    searchTerm: string;
    sortBy?: keyof TOrganizations;
  }) => {
    try {
      const query = db.replicaNode()(TableName.Organization);

      // Build the subquery for limited organization IDs
      const orgSubquery = db.replicaNode().select("id").from(TableName.Organization);

      if (searchTerm) {
        void orgSubquery.where((qb) => {
          void qb.whereILike(`${TableName.Organization}.name`, `%${searchTerm}%`);
        });
      }

      if (sortBy) {
        void orgSubquery.orderBy(sortBy);
      }

      void orgSubquery.limit(limit).offset(offset);

      // Main query with joins, limited to the subquery results
      const docs = await query
        .whereIn(`${TableName.Organization}.id`, orgSubquery)
        .leftJoin(TableName.Project, `${TableName.Organization}.id`, `${TableName.Project}.orgId`)
        .leftJoin(TableName.OrgMembership, `${TableName.Organization}.id`, `${TableName.OrgMembership}.orgId`)
        .leftJoin(TableName.Users, `${TableName.OrgMembership}.userId`, `${TableName.Users}.id`)
        .leftJoin(TableName.OrgRoles, `${TableName.OrgMembership}.roleId`, `${TableName.OrgRoles}.id`)
        .where((qb) => {
          void qb.where(`${TableName.Users}.isGhost`, false).orWhereNull(`${TableName.Users}.id`);
        })
        .select(selectAllTableCols(TableName.Organization))
        .select(db.ref("name").withSchema(TableName.Project).as("projectName"))
        .select(db.ref("id").withSchema(TableName.Project).as("projectId"))
        .select(db.ref("slug").withSchema(TableName.Project).as("projectSlug"))
        .select(db.ref("createdAt").withSchema(TableName.Project).as("projectCreatedAt"))
        .select(db.ref("email").withSchema(TableName.Users).as("userEmail"))
        .select(db.ref("username").withSchema(TableName.Users).as("username"))
        .select(db.ref("firstName").withSchema(TableName.Users).as("firstName"))
        .select(db.ref("lastName").withSchema(TableName.Users).as("lastName"))
        .select(db.ref("id").withSchema(TableName.Users).as("userId"))
        .select(db.ref("id").withSchema(TableName.OrgMembership).as("orgMembershipId"))
        .select(db.ref("role").withSchema(TableName.OrgMembership).as("orgMembershipRole"))
        .select(db.ref("roleId").withSchema(TableName.OrgMembership).as("orgMembershipRoleId"))
        .select(db.ref("name").withSchema(TableName.OrgRoles).as("orgMembershipRoleName"));

      const formattedDocs = sqlNestRelationships({
        data: docs,
        key: "id",
        parentMapper: (data) => OrganizationsSchema.parse(data),
        childrenMapper: [
          {
            key: "projectId",
            label: "projects" as const,
            mapper: ({ projectId, projectName, projectSlug, projectCreatedAt }) => ({
              id: projectId,
              name: projectName,
              slug: projectSlug,
              createdAt: projectCreatedAt
            })
          },
          {
            key: "userId",
            label: "members" as const,
            mapper: ({
              userId,
              userEmail,
              username,
              firstName,
              lastName,
              orgMembershipId,
              orgMembershipRole,
              orgMembershipRoleName,
              orgMembershipRoleId
            }) => ({
              user: {
                id: userId,
                email: userEmail,
                username,
                firstName,
                lastName
              },
              membershipId: orgMembershipId,
              role: orgMembershipRoleName || orgMembershipRole, // custom role name or pre-defined role name
              roleId: orgMembershipRoleId
            })
          }
        ]
      });

      return formattedDocs;
    } catch (error) {
      throw new DatabaseError({ error, name: "Find organizations by filter" });
    }
  };

  const findOrgById = async (orgId: string) => {
    try {
      const org = (await db
        .replicaNode()(TableName.Organization)
        .where({ [`${TableName.Organization}.id` as "id"]: orgId })
        .leftJoin(TableName.SamlConfig, (qb) => {
          qb.on(`${TableName.SamlConfig}.orgId`, "=", `${TableName.Organization}.id`).andOn(
            `${TableName.SamlConfig}.isActive`,
            "=",
            db.raw("true")
          );
        })
        .leftJoin(TableName.OidcConfig, (qb) => {
          qb.on(`${TableName.OidcConfig}.orgId`, "=", `${TableName.Organization}.id`).andOn(
            `${TableName.OidcConfig}.isActive`,
            "=",
            db.raw("true")
          );
        })
        .select(selectAllTableCols(TableName.Organization))
        .select(
          db.raw(`
            CASE
              WHEN ${TableName.SamlConfig}."orgId" IS NOT NULL THEN '${OrgAuthMethod.SAML}'
              WHEN ${TableName.OidcConfig}."orgId" IS NOT NULL THEN '${OrgAuthMethod.OIDC}'
              ELSE ''
            END as "orgAuthMethod"
        `)
        )
        .first()) as TOrganizations & { orgAuthMethod?: string };

      return org;
    } catch (error) {
      throw new DatabaseError({ error, name: "Find org by id" });
    }
  };

  const findOrgBySlug = async (orgSlug: string) => {
    try {
      const org = (await db
        .replicaNode()(TableName.Organization)
        .where({ [`${TableName.Organization}.slug` as "slug"]: orgSlug })
        .leftJoin(TableName.SamlConfig, (qb) => {
          qb.on(`${TableName.SamlConfig}.orgId`, "=", `${TableName.Organization}.id`).andOn(
            `${TableName.SamlConfig}.isActive`,
            "=",
            db.raw("true")
          );
        })
        .leftJoin(TableName.OidcConfig, (qb) => {
          qb.on(`${TableName.OidcConfig}.orgId`, "=", `${TableName.Organization}.id`).andOn(
            `${TableName.OidcConfig}.isActive`,
            "=",
            db.raw("true")
          );
        })
        .select(selectAllTableCols(TableName.Organization))
        .select(
          db.raw(`
            CASE
              WHEN ${TableName.SamlConfig}."orgId" IS NOT NULL THEN '${OrgAuthMethod.SAML}'
              WHEN ${TableName.OidcConfig}."orgId" IS NOT NULL THEN '${OrgAuthMethod.OIDC}'
              ELSE ''
            END as "orgAuthMethod"
        `)
        )
        .first()) as TOrganizations & { orgAuthMethod?: string };

      return org;
    } catch (error) {
      throw new DatabaseError({ error, name: "Find org by slug" });
    }
  };

  // special query
  const findAllOrgsByUserId = async (
    userId: string
  ): Promise<(TOrganizations & { orgAuthMethod: string; userRole: string; userStatus: string })[]> => {
    try {
      const org = (await db
        .replicaNode()(TableName.OrgMembership)
        .where({ userId })
        .join(TableName.Organization, `${TableName.OrgMembership}.orgId`, `${TableName.Organization}.id`)
        .leftJoin(TableName.SamlConfig, (qb) => {
          qb.on(`${TableName.SamlConfig}.orgId`, "=", `${TableName.Organization}.id`).andOn(
            `${TableName.SamlConfig}.isActive`,
            "=",
            db.raw("true")
          );
        })
        .leftJoin(TableName.OidcConfig, (qb) => {
          qb.on(`${TableName.OidcConfig}.orgId`, "=", `${TableName.Organization}.id`).andOn(
            `${TableName.OidcConfig}.isActive`,
            "=",
            db.raw("true")
          );
        })
        .select(selectAllTableCols(TableName.Organization))
        .select(db.ref("role").withSchema(TableName.OrgMembership).as("userRole"))
        .select(db.ref("status").withSchema(TableName.OrgMembership).as("userStatus"))
        .select(
          db.raw(`
            CASE
              WHEN ${TableName.SamlConfig}."orgId" IS NOT NULL THEN 'saml'
              WHEN ${TableName.OidcConfig}."orgId" IS NOT NULL THEN 'oidc'
              ELSE ''
            END as "orgAuthMethod"
        `)
        )) as (TOrganizations & { orgAuthMethod: string; userRole: string; userStatus: string })[];

      return org;
    } catch (error) {
      throw new DatabaseError({ error, name: "Find all org by user id" });
    }
  };

  const findOrgByProjectId = async (projectId: string): Promise<TOrganizations> => {
    try {
      const [org] = await db
        .replicaNode()(TableName.Project)
        .where({ [`${TableName.Project}.id` as "id"]: projectId })
        .join(TableName.Organization, `${TableName.Project}.orgId`, `${TableName.Organization}.id`)
        .select(selectAllTableCols(TableName.Organization));

      return org;
    } catch (error) {
      throw new DatabaseError({ error, name: "Find org by project id" });
    }
  };

  // special query
  const findAllOrgMembers = async (orgId: string) => {
    try {
      const members = await db
        .replicaNode()(TableName.OrgMembership)
        .where(`${TableName.OrgMembership}.orgId`, orgId)
        .join(TableName.Users, `${TableName.OrgMembership}.userId`, `${TableName.Users}.id`)
        .leftJoin<TUserEncryptionKeys>(
          TableName.UserEncryptionKey,
          `${TableName.UserEncryptionKey}.userId`,
          `${TableName.Users}.id`
        )
        .select(
          db.ref("id").withSchema(TableName.OrgMembership),
          db.ref("inviteEmail").withSchema(TableName.OrgMembership),
          db.ref("orgId").withSchema(TableName.OrgMembership),
          db.ref("role").withSchema(TableName.OrgMembership),
          db.ref("roleId").withSchema(TableName.OrgMembership),
          db.ref("status").withSchema(TableName.OrgMembership),
          db.ref("isActive").withSchema(TableName.OrgMembership),
          db.ref("email").withSchema(TableName.Users),
          db.ref("isEmailVerified").withSchema(TableName.Users),
          db.ref("username").withSchema(TableName.Users),
          db.ref("firstName").withSchema(TableName.Users),
          db.ref("lastName").withSchema(TableName.Users),
          db.ref("id").withSchema(TableName.Users).as("userId"),
          db.ref("superAdmin").withSchema(TableName.Users),
          db.ref("publicKey").withSchema(TableName.UserEncryptionKey)
        )
        .where({ isGhost: false }) // MAKE SURE USER IS NOT A GHOST USER
        .orderBy("firstName")
        .orderBy("lastName");

      return members.map(
        ({ email, isEmailVerified, username, firstName, lastName, userId, publicKey, superAdmin, ...data }) => ({
          ...data,
          user: { email, isEmailVerified, username, firstName, lastName, id: userId, publicKey, superAdmin }
        })
      );
    } catch (error) {
      throw new DatabaseError({ error, name: "Find all org members" });
    }
  };

  const countAllOrgMembers = async (orgId: string) => {
    try {
      interface CountResult {
        count: string;
      }

      const count = await db
        .replicaNode()(TableName.OrgMembership)
        .where(`${TableName.OrgMembership}.orgId`, orgId)
        .count("*")
        .join(TableName.Users, `${TableName.OrgMembership}.userId`, `${TableName.Users}.id`)
        .where({ isGhost: false, [`${TableName.OrgMembership}.isActive` as "isActive"]: true })
        .first();

      return parseInt((count as unknown as CountResult).count || "0", 10);
    } catch (error) {
      throw new DatabaseError({ error, name: "Count all org members" });
    }
  };

  const findOrgMembersByUsername = async (orgId: string, usernames: string[], tx?: Knex) => {
    try {
      const conn = tx || db.replicaNode();
      const members = await conn(TableName.OrgMembership)
        .where(`${TableName.OrgMembership}.orgId`, orgId)
        .join(TableName.Users, `${TableName.OrgMembership}.userId`, `${TableName.Users}.id`)
        .leftJoin<TUserEncryptionKeys>(
          TableName.UserEncryptionKey,
          `${TableName.UserEncryptionKey}.userId`,
          `${TableName.Users}.id`
        )
        .select(
          conn.ref("id").withSchema(TableName.OrgMembership),
          conn.ref("inviteEmail").withSchema(TableName.OrgMembership),
          conn.ref("orgId").withSchema(TableName.OrgMembership),
          conn.ref("role").withSchema(TableName.OrgMembership),
          conn.ref("roleId").withSchema(TableName.OrgMembership),
          conn.ref("status").withSchema(TableName.OrgMembership),
          conn.ref("username").withSchema(TableName.Users),
          conn.ref("email").withSchema(TableName.Users),
          conn.ref("firstName").withSchema(TableName.Users),
          conn.ref("lastName").withSchema(TableName.Users),
          conn.ref("id").withSchema(TableName.Users).as("userId"),
          conn.ref("publicKey").withSchema(TableName.UserEncryptionKey)
        )
        .where({ isGhost: false })
        .whereIn("username", usernames);
      return members.map(({ email, firstName, lastName, userId, publicKey, ...data }) => ({
        ...data,
        user: { email, firstName, lastName, id: userId, publicKey }
      }));
    } catch (error) {
      throw new DatabaseError({ error, name: "Find all org members" });
    }
  };

  const findOrgMembersByRole = async (orgId: string, role: OrgMembershipRole, tx?: Knex) => {
    try {
      const conn = tx || db.replicaNode();
      const members = await conn(TableName.OrgMembership)
        .where(`${TableName.OrgMembership}.orgId`, orgId)
        .where(`${TableName.OrgMembership}.role`, role)
        .join(TableName.Users, `${TableName.OrgMembership}.userId`, `${TableName.Users}.id`)
        .leftJoin<TUserEncryptionKeys>(
          TableName.UserEncryptionKey,
          `${TableName.UserEncryptionKey}.userId`,
          `${TableName.Users}.id`
        )
        .select(
          conn.ref("id").withSchema(TableName.OrgMembership),
          conn.ref("inviteEmail").withSchema(TableName.OrgMembership),
          conn.ref("orgId").withSchema(TableName.OrgMembership),
          conn.ref("role").withSchema(TableName.OrgMembership),
          conn.ref("roleId").withSchema(TableName.OrgMembership),
          conn.ref("status").withSchema(TableName.OrgMembership),
          conn.ref("username").withSchema(TableName.Users),
          conn.ref("email").withSchema(TableName.Users),
          conn.ref("firstName").withSchema(TableName.Users),
          conn.ref("lastName").withSchema(TableName.Users),
          conn.ref("id").withSchema(TableName.Users).as("userId"),
          conn.ref("publicKey").withSchema(TableName.UserEncryptionKey)
        )
        .where({ isGhost: false });

      return members.map(({ username, email, firstName, lastName, userId, publicKey, ...data }) => ({
        ...data,
        user: { username, email, firstName, lastName, id: userId, publicKey }
      }));
    } catch (error) {
      throw new DatabaseError({ error, name: "Find org members by role" });
    }
  };

  const findOrgGhostUser = async (orgId: string) => {
    try {
      const member = await db
        .replicaNode()(TableName.OrgMembership)
        .where({ orgId })
        .join(TableName.Users, `${TableName.OrgMembership}.userId`, `${TableName.Users}.id`)
        .leftJoin(TableName.UserEncryptionKey, `${TableName.UserEncryptionKey}.userId`, `${TableName.Users}.id`)
        .select(
          db.ref("id").withSchema(TableName.OrgMembership),
          db.ref("orgId").withSchema(TableName.OrgMembership),
          db.ref("role").withSchema(TableName.OrgMembership),
          db.ref("roleId").withSchema(TableName.OrgMembership),
          db.ref("status").withSchema(TableName.OrgMembership),
          db.ref("email").withSchema(TableName.Users),
          db.ref("id").withSchema(TableName.Users).as("userId"),
          db.ref("publicKey").withSchema(TableName.UserEncryptionKey)
        )
        .where({ isGhost: true })
        .first();
      return member;
    } catch (error) {
      return null;
    }
  };

  const ghostUserExists = async (orgId: string) => {
    try {
      const member = await db
        .replicaNode()(TableName.OrgMembership)
        .where({ orgId })
        .join(TableName.Users, `${TableName.OrgMembership}.userId`, `${TableName.Users}.id`)
        .leftJoin(TableName.UserEncryptionKey, `${TableName.UserEncryptionKey}.userId`, `${TableName.Users}.id`)
        .select(db.ref("id").withSchema(TableName.Users).as("userId"))
        .where({ isGhost: true })
        .first();
      return Boolean(member);
    } catch (error) {
      return false;
    }
  };

  const create = async (dto: TOrganizationsInsert, tx?: Knex) => {
    try {
      const [organization] = await (tx || db)(TableName.Organization).insert(dto).returning("*");
      return organization;
    } catch (error) {
      throw new DatabaseError({ error, name: "Create organization" });
    }
  };

  const deleteById = async (orgId: string, tx?: Knex) => {
    try {
      const [org] = await (tx || db)(TableName.Organization).where({ id: orgId }).delete().returning("*");
      return org;
    } catch (error) {
      throw new DatabaseError({ error, name: "Update organization" });
    }
  };

  const updateById = async (orgId: string, data: Partial<TOrganizations>, tx?: Knex) => {
    try {
      const [org] = await (tx || db)(TableName.Organization)
        .where({ id: orgId })
        .update({ ...data })
        .returning("*");
      return org;
    } catch (error) {
      throw new DatabaseError({ error, name: "Update organization" });
    }
  };

  // MEMBERSHIP OPERATIONS
  // --------------------
  // const orgMembershipOrm = ormify(db, TableName.OrgMembership);

  const createMembership = async (data: TOrgMembershipsInsert, tx?: Knex) => {
    try {
      const [membership] = await (tx || db)(TableName.OrgMembership).insert(data).returning("*");
      return membership;
    } catch (error) {
      throw new DatabaseError({ error, name: "Create org membership" });
    }
  };

  const updateMembershipById = async (id: string, data: TOrgMembershipsUpdate, tx?: Knex) => {
    try {
      const [membership] = await (tx || db)(TableName.OrgMembership).where({ id }).update(data).returning("*");
      return membership;
    } catch (error) {
      throw new DatabaseError({ error, name: "Update org membership" });
    }
  };

  const updateMembership = async (filter: Partial<TOrgMemberships>, data: TOrgMembershipsUpdate, tx?: Knex) => {
    try {
      const membership = await (tx || db)(TableName.OrgMembership).where(filter).update(data).returning("*");
      return membership;
    } catch (error) {
      throw new DatabaseError({ error, name: "Update org memberships" });
    }
  };

  const deleteMembershipById = async (id: string, orgId: string, tx?: Knex) => {
    try {
      const [membership] = await (tx || db)(TableName.OrgMembership).where({ id, orgId }).delete().returning("*");
      return membership;
    } catch (error) {
      throw new DatabaseError({ error, name: "Delete org membership" });
    }
  };

  const deleteMembershipsById = async (ids: string[], orgId: string, tx?: Knex) => {
    try {
      const memberships = await (tx || db)(TableName.OrgMembership)
        .where({
          orgId
        })
        .whereIn("id", ids)
        .delete()
        .returning("*");
      return memberships;
    } catch (error) {
      throw new DatabaseError({ error, name: "Delete org memberships" });
    }
  };

  const findMembership = async (
    filter: TFindFilter<TOrgMemberships>,
    { offset, limit, sort, tx }: TFindOpt<TOrgMemberships> = {}
  ) => {
    try {
      const query = (tx || db.replicaNode())(TableName.OrgMembership)
        // eslint-disable-next-line
        .where(buildFindFilter(filter))
        .join(TableName.Users, `${TableName.Users}.id`, `${TableName.OrgMembership}.userId`)
        .join(TableName.Organization, `${TableName.Organization}.id`, `${TableName.OrgMembership}.orgId`)
        .leftJoin(TableName.UserAliases, function joinUserAlias() {
          this.on(`${TableName.UserAliases}.userId`, "=", `${TableName.OrgMembership}.userId`)
            .andOn(`${TableName.UserAliases}.orgId`, "=", `${TableName.OrgMembership}.orgId`)
            .andOn(`${TableName.UserAliases}.aliasType`, "=", (tx || db).raw("?", ["saml"]));
        })
        .select(
          selectAllTableCols(TableName.OrgMembership),
          db.ref("email").withSchema(TableName.Users),
          db.ref("isEmailVerified").withSchema(TableName.Users),
          db.ref("username").withSchema(TableName.Users),
          db.ref("firstName").withSchema(TableName.Users),
          db.ref("lastName").withSchema(TableName.Users),
          db.ref("scimEnabled").withSchema(TableName.Organization),
          db.ref("externalId").withSchema(TableName.UserAliases)
        )
        .where({ isGhost: false });

      if (limit) void query.limit(limit);
      if (offset) void query.offset(offset);
      if (sort) {
        void query.orderBy(sort.map(([column, order, nulls]) => ({ column: column as string, order, nulls })));
      }
      const res = await query;
      return res;
    } catch (error) {
      throw new DatabaseError({ error, name: "Find one" });
    }
  };

  const findMembershipWithScimFilter = async (
    orgId: string,
    scimFilter: string | undefined,
    { offset, limit, sort, tx }: TFindOpt<TOrgMemberships> = {}
  ) => {
    try {
      const query = (tx || db.replicaNode())(TableName.OrgMembership)
        // eslint-disable-next-line
        .where(`${TableName.OrgMembership}.orgId`, orgId)
        .where((qb) => {
          if (scimFilter) {
            void generateKnexQueryFromScim(qb, scimFilter, (attrPath) => {
              switch (attrPath) {
                case "active":
                  return `${TableName.OrgMembership}.isActive`;
                case "userName":
                  return `${TableName.UserAliases}.externalId`;
                case "name.givenName":
                  return `${TableName.Users}.firstName`;
                case "name.familyName":
                  return `${TableName.Users}.lastName`;
                case "email.value":
                  return `${TableName.Users}.email`;
                default:
                  return null;
              }
            });
          }
        })
        .join(TableName.Users, `${TableName.Users}.id`, `${TableName.OrgMembership}.userId`)
        .join(TableName.Organization, `${TableName.Organization}.id`, `${TableName.OrgMembership}.orgId`)
        .leftJoin(TableName.UserAliases, function joinUserAlias() {
          this.on(`${TableName.UserAliases}.userId`, "=", `${TableName.OrgMembership}.userId`)
            .andOn(`${TableName.UserAliases}.orgId`, "=", `${TableName.OrgMembership}.orgId`)
            .andOn(`${TableName.UserAliases}.aliasType`, "=", (tx || db).raw("?", ["saml"]));
        })
        .select(
          selectAllTableCols(TableName.OrgMembership),
          db.ref("email").withSchema(TableName.Users),
          db.ref("isEmailVerified").withSchema(TableName.Users),
          db.ref("username").withSchema(TableName.Users),
          db.ref("firstName").withSchema(TableName.Users),
          db.ref("lastName").withSchema(TableName.Users),
          db.ref("scimEnabled").withSchema(TableName.Organization),
          db.ref("defaultMembershipRole").withSchema(TableName.Organization),
          db.ref("externalId").withSchema(TableName.UserAliases)
        )
        .where({ isGhost: false });

      if (limit) void query.limit(limit);
      if (offset) void query.offset(offset);
      if (sort) {
        void query.orderBy(sort.map(([column, order, nulls]) => ({ column: column as string, order, nulls })));
      }
      const res = await query;
      return res;
    } catch (error) {
      throw new DatabaseError({ error, name: "Find one" });
    }
  };

  return withTransaction(db, {
    ...orgOrm,
    findOrgByProjectId,
    findAllOrgMembers,
    countAllOrgMembers,
    findOrgById,
    findOrgBySlug,
    findAllOrgsByUserId,
    findOrganizationsByFilter,
    ghostUserExists,
    findOrgMembersByUsername,
    findOrgMembersByRole,
    findOrgGhostUser,
    create,
    updateById,
    deleteById,
    findMembership,
    findMembershipWithScimFilter,
    createMembership,
    updateMembershipById,
    deleteMembershipById,
    deleteMembershipsById,
    updateMembership
  });
};
