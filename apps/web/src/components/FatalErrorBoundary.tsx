import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode; }
interface State { failed: boolean; }

export class FatalErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Color Turf client render failed", error, info);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <main className="fatal-client-page"><p>COLOR TURF ARENA</p><h1>참가 화면을 불러오지 못했습니다.</h1><span>네트워크를 확인한 뒤 다시 연결해 주세요. 진행 중인 팀과 세션은 가능한 경우 자동 복구됩니다.</span><button className="button button-primary" type="button" onClick={() => window.location.reload()}>다시 연결</button></main>;
  }
}
