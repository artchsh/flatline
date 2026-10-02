<template>
    <div class="d-flex align-items-center justify-content-center" style="min-height: 100vh">
        <div class="shadow-box" style="max-width: 480px; width: 100%">
            <h5 class="mb-3">{{ $t("Set up your account") }}</h5>

            <div v-if="checking" class="text-center py-4">
                <div class="spinner-border" role="status"></div>
            </div>

            <div v-else-if="error" class="alert alert-danger" role="alert">
                {{ error }}
                <div class="mt-3">
                    <router-link to="/" class="btn btn-outline-secondary btn-sm">
                        {{ $t("Go to Dashboard") }}
                    </router-link>
                </div>
            </div>

            <form v-else @submit.prevent="submit">
                <p v-if="note" class="text-muted">{{ $t("Invited by") }}: {{ note }}</p>

                <div class="mb-3">
                    <label for="invite-username" class="form-label">{{ $t("Username") }}</label>
                    <input
                        id="invite-username"
                        v-model="username"
                        type="text"
                        class="form-control"
                        autocomplete="username"
                        required
                    />
                </div>

                <div class="mb-3">
                    <label for="invite-password" class="form-label">{{ $t("Password") }}</label>
                    <input
                        id="invite-password"
                        v-model="password"
                        type="password"
                        class="form-control"
                        autocomplete="new-password"
                        required
                    />
                    <div class="form-text">{{ $t("userInvitePasswordHint") }}</div>
                </div>

                <div class="mb-3">
                    <label for="invite-password2" class="form-label">{{ $t("Repeat Password") }}</label>
                    <input
                        id="invite-password2"
                        v-model="password2"
                        type="password"
                        class="form-control"
                        autocomplete="new-password"
                        required
                    />
                </div>

                <button class="btn btn-primary" type="submit" :disabled="processing">
                    <div v-if="processing" class="spinner-border spinner-border-sm me-1"></div>
                    {{ $t("Create account") }}
                </button>
            </form>
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return {
            token: this.$route.params.token,
            username: "",
            password: "",
            password2: "",
            processing: false,
            checking: true,
            error: null,
            note: null,
        };
    },
    mounted() {
        this.checkInvite();
    },
    methods: {
        /**
         * Verify the link before showing the form, so an expired invite says
         * so instead of failing on submit.
         * @returns {void}
         */
        checkInvite() {
            this.$root.getSocket().emit("checkUserInvite", this.token, (res) => {
                this.checking = false;

                if (!res.ok) {
                    this.error = res.msg;
                    return;
                }

                this.note = res.note;
            });
        },

        /**
         * Redeem the invite and create the account
         * @returns {void}
         */
        submit() {
            if (this.password !== this.password2) {
                this.error = this.$t("Passwords do not match.");
                return;
            }

            this.processing = true;
            this.error = null;

            this.$root.getSocket().emit(
                "redeemUserInvite",
                this.token,
                this.username,
                this.password,
                (res) => {
                    this.processing = false;

                    if (!res.ok) {
                        this.error = res.msg;
                        return;
                    }

                    // The account exists now; send them to log in.
                    this.$root.toast(this.$t("userInviteRedeemed"));
                    this.$router.push("/");
                }
            );
        },
    },
};
</script>