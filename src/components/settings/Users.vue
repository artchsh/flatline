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
    </div>
</template>

<script>
import CopyableInput from "../CopyableInput.vue";

export default {
    components: {
        CopyableInput,
    },
    data() {
        return {
            note: "",
            expiryHours: 24,
            processing: false,
            // Shown once after minting; the server never returns it again.
            lastToken: null,
            lastExpires: null,
        };
    },
    computed: {
        invites() {
            const list = this.$root.userInviteList ?? {};
            return Object.values(list);
        },
    },
    mounted() {
        this.$root.getSocket().emit("getUserInviteList");
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
    },
};
</script>