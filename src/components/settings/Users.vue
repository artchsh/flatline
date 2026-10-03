<template>
    <div class="shadow-box">
        <h5 class="mb-3">{{ $t("Users") }}</h5>

        <p class="text-muted">
            {{ $t("userInviteDescription") }}
        </p>

        <div v-if="lastToken" class="alert alert-success" role="alert">
            <h6 class="alert-heading">{{ $t("userInviteCreated") }}</h6>
            <p>{{ $t("userInviteCopyWarning") }}</p>
            <CopyableInput :model="lastToken" />
            <p class="mt-2 mb-0 small">
                {{ $t("userInviteExpiresAt", { date: lastExpires }) }}
            </p>
        </div>

        <div class="mb-3">
            <label for="invite-note" class="form-label">{{ $t("userInviteNote") }}</label>
            <input
                id="invite-note"
                v-model="note"
                type="text"
                class="form-control"
                :placeholder="$t('userInviteNotePlaceholder')"
            />
        </div>

        <div class="mb-3">
            <label for="invite-expiry" class="form-label">{{ $t("userInviteExpiry") }}</label>
            <select id="invite-expiry" v-model="expiryHours" class="form-select">
                <option :value="1">{{ $t("userInviteExpiry1h") }}</option>
                <option :value="24">{{ $t("userInviteExpiry24h") }}</option>
                <option :value="72">{{ $t("userInviteExpiry72h") }}</option>
                <option :value="168">{{ $t("userInviteExpiry7d") }}</option>
            </select>
        </div>

        <button class="btn btn-primary" type="button" :disabled="processing" @click="createInvite">
            {{ $t("userInviteCreate") }}
        </button>

        <hr class="my-4" />

        <h6>{{ $t("userInviteList") }}</h6>

        <p v-if="invites.length === 0" class="text-muted">{{ $t("userInviteNone") }}</p>

        <div v-for="invite in invites" :key="invite.id" class="border rounded p-2 mb-2 d-flex justify-content-between align-items-center">
            <div>
                <div>
                    <strong>{{ invite.note || $t("userInviteUnnamed") }}</strong>
                    <span class="badge ms-2" :class="statusClass(invite.status)">{{ invite.status }}</span>
                </div>
                <small class="text-muted">
                    {{ $t("userInviteCreatedAt", { date: invite.createdDate }) }}
                    <template v-if="invite.status === 'active'">
                        · {{ $t("userInviteExpiresAt", { date: invite.expires }) }}
                    </template>
                    <template v-else-if="invite.usedAt">
                        · {{ $t("userInviteUsedAt", { date: invite.usedAt }) }}
                    </template>
                </small>
            </div>
            <button
                v-if="invite.status === 'active'"
                class="btn btn-sm btn-outline-danger"
                type="button"
                :disabled="processing"
                @click="revoke(invite)"
            >
                {{ $t("Revoke") }}
            </button>
        </div>

        <hr class="my-4" />

        <h6>{{ $t("Accounts") }}</h6>
        <p class="text-muted">{{ $t("userAccountsDescription") }}</p>

        <div class="table-responsive">
            <table class="table align-middle">
                <thead>
                    <tr>
                        <th>{{ $t("Username") }}</th>
                        <th>{{ $t("Email") }}</th>
                        <th class="text-end">{{ $t("Actions") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="user in users" :key="user.id">
                        <td>
                            {{ user.username || user.name }}
                            <span v-if="user.isCurrent" class="badge bg-primary ms-2">{{ $t("You") }}</span>
                            <span v-if="user.banned" class="badge bg-danger ms-2">{{ $t("Banned") }}</span>
                        </td>
                        <td class="text-muted">{{ user.email }}</td>
                        <td class="text-end">
                            <button
                                v-if="!user.isCurrent"
                                class="btn btn-sm btn-outline-secondary me-1"
                                type="button"
                                :disabled="processing"
                                @click="setBanned(user, !user.banned)"
                            >
                                {{ user.banned ? $t("Unban") : $t("Ban") }}
                            </button>
                            <button
                                v-if="!user.isCurrent"
                                class="btn btn-sm btn-outline-danger"
                                type="button"
                                :disabled="processing"
                                @click="confirmDelete(user)"
                            >
                                {{ $t("Delete") }}
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <Confirm
        ref="confirmDelete"
        btn-style="btn-danger"
        :yes-text="$t('Yes')"
        :no-text="$t('No')"
        @yes="doDelete"
    >
        {{ $t("userDeleteConfirm") }}
    </Confirm>
</template>

<script>
import CopyableInput from "../CopyableInput.vue";
import Confirm from "../Confirm.vue";

export default {
    components: {
        CopyableInput,
        Confirm,
    },
    data() {
        return {
            note: "",
            expiryHours: 24,
            processing: false,
            // Shown once after minting; the server never returns it again.
            lastToken: null,
            lastExpires: null,
            pendingDelete: null,
        };
    },
    computed: {
        invites() {
            const list = this.$root.userInviteList ?? {};
            return Object.values(list);
        },
        users() {
            return this.$root.userList ?? [];
        },
    },
    mounted() {
        this.$root.getSocket().emit("getUserInviteList");
        this.$root.getSocket().emit("getUserList");
    },
    methods: {
        /**
         * Bootstrap badge class for an invite status
         * @param {string} status active, used or expired
         * @returns {string} Badge class
         */
        statusClass(status) {
            return {
                active: "bg-primary",
                used: "bg-success",
                expired: "bg-secondary",
            }[status] ?? "bg-secondary";
        },

        /**
         * Mint a new invite link
         * @returns {void}
         */
        createInvite() {
            this.processing = true;
            this.$root.getSocket().emit(
                "createUserInvite",
                { note: this.note, expiryHours: this.expiryHours },
                (res) => {
                    this.processing = false;

                    if (!res.ok) {
                        this.$root.toastRes(res);
                        return;
                    }

                    this.note = "";
                    this.lastToken = this.buildLink(res.token);
                    this.lastExpires = res.expires;
                }
            );
        },

        /**
         * Build an absolute invite URL for the current host
         * @param {string} token Plaintext token, shown only once
         * @returns {string} Full invite link
         */
        buildLink(token) {
            return `${window.location.origin}/invite/${token}`;
        },

        /**
         * Revoke an unused invite
         * @param {object} invite Invite to revoke
         * @returns {void}
         */
        revoke(invite) {
            this.processing = true;
            this.$root.getSocket().emit("revokeUserInvite", invite.id, (res) => {
                this.processing = false;
                this.$root.toastRes(res);
            });
        },

        /**
         * Ban or unban an account
         * @param {object} user Account to change
         * @param {boolean} banned Desired state
         * @returns {void}
         */
        setBanned(user, banned) {
            this.processing = true;
            this.$root.getSocket().emit("setUserBanned", user.id, banned, (res) => {
                this.processing = false;
                this.$root.toastRes(res);
            });
        },

        /**
         * Ask for confirmation before removing an account
         * @param {object} user Account to remove
         * @returns {void}
         */
        confirmDelete(user) {
            this.pendingDelete = user;
            this.$refs.confirmDelete.show();
        },

        /**
         * Remove the account chosen in confirmDelete
         * @returns {void}
         */
        doDelete() {
            if (!this.pendingDelete) {
                return;
            }

            this.processing = true;
            this.$root.getSocket().emit("deleteUser", this.pendingDelete.id, (res) => {
                this.processing = false;
                this.pendingDelete = null;
                this.$root.toastRes(res);
            });
        },
    },
};
</script>