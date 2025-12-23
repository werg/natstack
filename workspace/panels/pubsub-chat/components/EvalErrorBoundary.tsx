import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Called when an error is caught - parent should remove this component */
  onError: (error: Error) => void;
}

interface State {
  hasError: boolean;
}

export class EvalErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}
