// OpenUtau 헤드리스 렌더러: USTX 프로젝트를 UI 없이 WAV로 믹스다운한다.
// 사용법: OuRender <project.ustx> <out.wav>
// (반드시 OpenUtau 폴더에서 실행 — DataPath/Singers가 실행 파일 위치 기준으로 잡힘)
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text;
using OpenUtau.Classic;
using OpenUtau.Core;
using OpenUtau.Core.Format;

class ProgressListener : ICmdSubscriber {
    public void OnNext(UCommand cmd, bool isUndo) {
        if (cmd is ProgressBarNotification p) {
            Console.WriteLine($"PROGRESS|{p.Progress:0}|{p.Info}");
        } else if (cmd is ErrorMessageNotification e) {
            Console.Error.WriteLine($"ERRORNOTE|{e.message}|{e.e?.GetBaseException().Message}");
        }
    }
}

class Program {
    static int Main(string[] args) {
        // deps.json에 없는 OpenUtau DLL들을 실행 폴더에서 로드
        AssemblyLoadContext.Default.Resolving += (ctx, name) => {
            string p = Path.Combine(AppContext.BaseDirectory, name.Name + ".dll");
            return File.Exists(p) ? ctx.LoadFromAssemblyPath(p) : null;
        };
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance); // shift_jis 등 (보이스뱅크 로딩에 필요)
        return Run(args);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    static int Run(string[] args) {
        Console.OutputEncoding = Encoding.UTF8;
        Console.InputEncoding = Encoding.UTF8;
        if (args.Length < 2) {
            Console.Error.WriteLine("usage: OuRender <project.ustx> <out.wav>");
            return 2;
        }
        string projectPath = Path.GetFullPath(args[0]);
        string outPath = Path.GetFullPath(args[1]);
        if (!File.Exists(projectPath)) {
            Console.Error.WriteLine($"project not found: {projectPath}");
            return 2;
        }
        try {
            SynchronizationContext.SetSynchronizationContext(new SynchronizationContext());
            var mainThread = Thread.CurrentThread;
            var mainScheduler = TaskScheduler.FromCurrentSynchronizationContext();

            Console.WriteLine("PROGRESS|0|Initializing");
            Console.WriteLine($"INFO|DataPath={PathManager.Inst.DataPath}|SingersPath={PathManager.Inst.SingersPath}");
            ToolsManager.Inst.Initialize();
            SingerManager.Inst.Initialize();
            Console.WriteLine($"INFO|singers={SingerManager.Inst.Singers.Count}|ids=[{string.Join(", ", SingerManager.Inst.Singers.Keys)}]");
            if (SingerManager.Inst.Singers.Count == 0) {
                foreach (var dir in Directory.GetDirectories(PathManager.Inst.SingersPath)) {
                    var charTxt = Path.Combine(dir, "character.txt");
                    if (!File.Exists(charTxt)) { Console.WriteLine($"DIAG|{dir}: character.txt 없음"); continue; }
                    try {
                        var vb = new OpenUtau.Classic.Voicebank();
                        OpenUtau.Classic.VoicebankLoader.LoadInfo(vb, charTxt, PathManager.Inst.SingersPath);
                        Console.WriteLine($"DIAG|LoadInfo OK: id={vb.Id} type={vb.SingerType}");
                    } catch (Exception ex) {
                        Console.Error.WriteLine($"DIAG|LoadInfo 실패: {ex}");
                    }
                }
            }
            DocManager.Inst.Initialize(mainThread, mainScheduler);
            // 백그라운드 스레드에서 온 명령을 메인 스레드 큐로 디스패치 (즉시 실행하면 무한 재귀)
            var uiQueue = new System.Collections.Concurrent.BlockingCollection<Action>();
            DocManager.Inst.PostOnUIThread = action => uiQueue.Add(action);
            DocManager.Inst.AddSubscriber(new ProgressListener());

            Console.WriteLine("PROGRESS|0|Loading project");
            var project = Ustx.Load(projectPath);
            int noteCount = 0;
            foreach (var part in project.parts) {
                if (part is OpenUtau.Core.Ustx.UVoicePart vp) noteCount += vp.notes.Count;
            }
            var track0 = project.tracks.Count > 0 ? project.tracks[0] : null;
            Console.WriteLine($"INFO|tracks={project.tracks.Count}|parts={project.parts.Count}|notes={noteCount}|singer={track0?.Singer?.Name ?? "(없음)"}|phonemizer={track0?.Phonemizer?.GetType().Name ?? "(없음)"}|renderer={track0?.RendererSettings?.Renderer?.ToString() ?? "(없음)"}");
            if (noteCount == 0) { Console.Error.WriteLine("FATAL|프로젝트에 음표가 없습니다 (USTX 로드 실패)"); return 1; }
            if (track0?.Singer == null || !track0.Singer.Found) { Console.Error.WriteLine("FATAL|가수(보이스뱅크)를 찾지 못했습니다"); return 1; }

            // 프로젝트를 현재 문서로 등록 (포네마이저 응답이 현재 프로젝트의 파트에만 적용됨)
            DocManager.Inst.ExecuteCmd(new LoadProjectNotification(project));

            // 포네마이즈(가사→음소) 비동기 완료 대기
            Console.WriteLine("PROGRESS|0|Phonemizing");
            var deadline = DateTime.Now.AddMinutes(5);
            while (DateTime.Now < deadline) {
                while (uiQueue.TryTake(out var a0)) { try { a0(); } catch { } }
                bool upToDate = project.parts.OfType<OpenUtau.Core.Ustx.UVoicePart>().All(p => p.PhonemesUpToDate && p.renderPhrases.Count > 0);
                if (upToDate) break;
                Thread.Sleep(150);
            }
            foreach (var p in project.parts.OfType<OpenUtau.Core.Ustx.UVoicePart>()) {
                Console.WriteLine($"INFO|part phrases={p.renderPhrases.Count} phonemesUpToDate={p.PhonemesUpToDate}");
            }

            Console.WriteLine("PROGRESS|0|Rendering");
            var renderTask = PlaybackManager.Inst.RenderMixdown(project, outPath);
            while (!renderTask.IsCompleted) {
                if (uiQueue.TryTake(out var action, 200)) {
                    try { action(); } catch (Exception ex) { Console.Error.WriteLine("dispatch: " + ex.Message); }
                }
            }
            while (uiQueue.TryTake(out var rest)) {
                try { rest(); } catch { }
            }
            renderTask.Wait();

            if (File.Exists(outPath) && new FileInfo(outPath).Length > 1000) {
                Console.WriteLine($"DONE|{outPath}");
                return 0;
            }
            Console.Error.WriteLine("render finished but output file missing/empty");
            return 1;
        } catch (Exception ex) {
            Console.Error.WriteLine("FATAL|" + ex.GetBaseException().Message);
            return 1;
        }
    }
}
