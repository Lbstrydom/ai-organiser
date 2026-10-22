/**
 * SetupFlow: the pure state machine behind every guided setup modal.
 *
 * Rules:
 *  - `next()` runs the current step's `validate`; a failure keeps the user on the step and
 *    returns the error code (the modal shows its guidance). Local validation blocks Next.
 *  - `finish()` validates the last step, then runs `onFinish` exactly once. Ordinary settings
 *    are written only there. A cancelled flow never calls it.
 *  - External verification (a connection test) is NOT a validate gate: steps that run one do
 *    so as an action and may still be finished, so a failing test never traps the user.
 */
import { Result, ok, err } from '../../core/result';

export interface FlowStep {
    id: string;
    /** Local validation only. Return `err(code)` to block moving on. */
    validate?: () => Result<void> | Promise<Result<void>>;
}

export class SetupFlow {
    private index = 0;
    private finished = false;
    private cancelledFlag = false;
    private finishing = false;
    /** True only while onFinish runs; cancelling is possible up to that moment. */
    private persisting = false;

    constructor(
        private readonly steps: readonly FlowStep[],
        private readonly onFinish: () => Result<void> | Promise<Result<void>>,
    ) {
        if (steps.length === 0) throw new Error('SetupFlow needs at least one step');
    }

    get stepIndex(): number { return this.index; }
    get stepCount(): number { return this.steps.length; }
    get current(): FlowStep { return this.steps[this.index]; }
    get isFirst(): boolean { return this.index === 0; }
    get isLast(): boolean { return this.index === this.steps.length - 1; }
    get isFinished(): boolean { return this.finished; }
    get isCancelled(): boolean { return this.cancelledFlag; }
    /** True while the save is in flight; closing the dialog at this point does not cancel it. */
    get isFinishing(): boolean { return this.persisting; }

    /** Advance after validating the current step. Stays put and returns the error on failure. */
    async next(): Promise<Result<void>> {
        if (this.finished || this.cancelledFlag || this.isLast) return err('invalid-state');
        const res = await this.validateCurrent();
        if (!res.ok) return res;
        if (this.cancelledFlag) return err('invalid-state'); // closed while the check was pending
        this.index++;
        return ok(undefined);
    }

    back(): void {
        if (this.index > 0 && !this.finished) this.index--;
    }

    /** Validate the last step and commit once. A second call is a no-op error. */
    async finish(): Promise<Result<void>> {
        if (this.finished || this.finishing || this.cancelledFlag) return err('invalid-state');
        if (!this.isLast) return err('invalid-state');
        this.finishing = true;
        try {
            const valid = await this.validateCurrent();
            if (!valid.ok) return valid;
            // Closing the dialog while validation was pending must still stop the save.
            if (this.cancelledFlag) return err('invalid-state');
            let saved: Result<void>;
            this.persisting = true;
            try {
                saved = await this.onFinish();
            } catch {
                saved = err('write-failed');
            } finally {
                this.persisting = false;
            }
            if (saved.ok) this.finished = true;
            return saved;
        } finally {
            this.finishing = false;
        }
    }

    /** Close without saving. After this `finish` refuses. */
    cancel(): void {
        // Once the save has started it is not cancellable: claiming "cancelled" while it completes
        // would leave the flow and the dialog disagreeing about what was saved.
        if (!this.finished && !this.persisting) this.cancelledFlag = true;
    }

    private async validateCurrent(): Promise<Result<void>> {
        const validate = this.current.validate;
        if (!validate) return ok(undefined);
        try {
            return await validate();
        } catch {
            return err('validation-failed');
        }
    }
}
