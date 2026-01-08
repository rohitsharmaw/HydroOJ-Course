import { escapeRegExp, pick } from 'lodash';
import {
    Context, DiscussionModel, DocumentModel, FileLimitExceededError,
    FileUploadError, Filter, Handler, NotFoundError, ObjectId, PERM, ProblemModel, PRIV, RecordModel,
    sortFiles, StorageModel, SystemModel, Time, UserModel, ValidationError,
} from 'hydrooj';
import { param, post, Types } from 'hydrooj';

// Extend document types for Course
declare module 'hydrooj' {
    interface DocType {
        50: CourseDoc; // TYPE_COURSE
    }
}

// Course document interface
export interface CourseDoc {
    _id: ObjectId;
    docType: 50;
    docId: ObjectId;
    domainId: string;
    owner: number;
    maintainer?: number[];
    title: string;
    content: string; // Course introduction/description
    beginAt: Date;
    endAt: Date;
    attend: number; // Number of students enrolled
    pids: number[]; // Problem IDs
    files?: Array<{ _id: string; name: string; size?: number; lastModified?: Date; etag?: string }>;
    assign?: string[]; // Assigned classes/groups
    classes?: string[]; // Multiple classes support
    teachers?: number[]; // Multiple teachers
}

// Course status document interface (per student progress)
export interface CourseStatusDoc {
    _id: ObjectId;
    docType: 50;
    docId: ObjectId;
    domainId: string;
    uid: number;
    enroll?: number;
    attend?: number;
    startAt?: Date;
    progress?: Record<number, { rid?: ObjectId; score?: number; status?: number }>;
    journal?: Array<{ pid: number; rid: ObjectId; score: number; status: number }>;
}

const TYPE_COURSE = 50;

// Course Model
export const CourseModel = {
    TYPE_COURSE,

    async add(
        domainId: string,
        title: string,
        content: string,
        owner: number,
        pids: number[] = [],
        beginAt: Date = new Date(),
        endAt: Date = new Date(Date.now() + 30 * Time.day),
        args: Partial<CourseDoc> = {},
    ): Promise<ObjectId> {
        const docId = await DocumentModel.add(
            domainId,
            content,
            owner,
            TYPE_COURSE,
            null,
            null,
            null,
            {
                title,
                beginAt,
                endAt,
                pids,
                attend: 0,
                ...args,
            },
        );
        return docId as ObjectId;
    },

    async get(domainId: string, cid: ObjectId): Promise<CourseDoc | null> {
        const doc = await DocumentModel.get(domainId, TYPE_COURSE, cid);
        if (!doc) return null;
        return doc as unknown as CourseDoc;
    },

    getMulti(domainId: string, query: Filter<CourseDoc> = {}) {
        return DocumentModel.getMulti(domainId, TYPE_COURSE, query).sort({ beginAt: -1, _id: -1 });
    },

    async edit(domainId: string, cid: ObjectId, $set: Partial<CourseDoc>) {
        return await DocumentModel.set(domainId, TYPE_COURSE, cid, $set as any);
    },

    async del(domainId: string, cid: ObjectId) {
        return await Promise.all([
            DocumentModel.deleteOne(domainId, TYPE_COURSE, cid),
            DocumentModel.deleteMultiStatus(domainId, TYPE_COURSE, { docId: cid }),
        ]);
    },

    async getStatus(domainId: string, cid: ObjectId, uid: number) {
        return await DocumentModel.getStatus(domainId, TYPE_COURSE, cid, uid);
    },

    getMultiStatus(domainId: string, query: Filter<CourseStatusDoc>) {
        return DocumentModel.getMultiStatus(domainId, TYPE_COURSE, query);
    },

    async setStatus(domainId: string, cid: ObjectId, uid: number, $set: Partial<CourseStatusDoc>) {
        return await DocumentModel.setStatus(domainId, TYPE_COURSE, cid, uid, $set);
    },

    async attend(domainId: string, cid: ObjectId, uid: number) {
        try {
            await DocumentModel.setIfNotStatus(domainId, TYPE_COURSE, cid, uid, 'attend', 1, 1, { enroll: 1, startAt: new Date() });
        } catch (e) {
            throw new Error('Already enrolled in this course');
        }
        return await DocumentModel.inc(domainId, TYPE_COURSE, cid, 'attend', 1);
    },

    async count(domainId: string, query: Filter<CourseDoc> = {}) {
        return await DocumentModel.count(domainId, TYPE_COURSE, query);
    },

    isOngoing(cdoc: CourseDoc) {
        const now = new Date();
        return cdoc.beginAt <= now && now < cdoc.endAt;
    },

    isNotStarted(cdoc: CourseDoc) {
        return new Date() < cdoc.beginAt;
    },

    isDone(cdoc: CourseDoc) {
        return cdoc.endAt <= new Date();
    },
};

// Error class for course not found
class CourseNotFoundError extends NotFoundError {
    constructor(domainId: string, cid: ObjectId) {
        super('Course', cid.toString());
        this.params = [domainId, cid];
    }
}

// Main Course List Handler
class CourseMainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    @param('group', Types.Name, true)
    async get(domainId: string, page = 1, q = '', group = '') {
        const groups = (await UserModel.listGroup(domainId, this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) ? undefined : this.user._id))
            .map((i) => i.name);

        const escaped = escapeRegExp(q.toLowerCase());
        
        // Build base query
        const query: Filter<CourseDoc> = {};
        
        // Access control query
        if (!(this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) && !group)) {
            const accessConditions = [
                { maintainer: this.user._id },
                { owner: this.user._id },
                { teachers: this.user._id },
                { assign: { $in: groups } },
                { classes: { $in: groups } },
                { assign: { $size: 0 } },
            ];
            
            if (group) {
                // Filter by specific group/class
                accessConditions.push({ assign: { $in: [group] } });
                accessConditions.push({ classes: { $in: [group] } });
            }
            
            query.$or = accessConditions;
        }
        
        // Title search query
        if (q) {
            query.title = { $regex: new RegExp(q.length >= 2 ? escaped : `^${escaped}`, 'gim') };
        }

        const cursor = CourseModel.getMulti(domainId, query);
        const [cdocs, cpcount] = await this.paginate(cursor, page, 'course');

        const tids: Set<ObjectId> = new Set();
        for (const cdoc of cdocs) tids.add(cdoc.docId);

        let csdict = {};
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            const csdocs = await CourseModel.getMultiStatus(domainId, {
                uid: this.user._id,
                docId: { $in: Array.from(tids) },
            }).toArray();
            for (const csdoc of csdocs) csdict[csdoc.docId.toString()] = csdoc;
        }

        let qs = group ? `group=${group}` : '';
        if (q) qs += `${qs ? '&' : ''}q=${encodeURIComponent(q)}`;
        const groupsFilter = groups.filter((i) => !Number.isSafeInteger(+i));

        this.response.body = {
            cdocs,
            csdict,
            page,
            cpcount,
            qs,
            groups: groupsFilter,
            group,
            q,
        };
        this.response.template = 'course_main.html';
    }
}

// Course Detail Handler
class CourseDetailHandler extends Handler {
    cdoc: CourseDoc;

    @param('cid', Types.ObjectId)
    async prepare(domainId: string, cid: ObjectId) {
        this.cdoc = await CourseModel.get(domainId, cid);
        if (!this.cdoc) throw new CourseNotFoundError(domainId, cid);

        // Check if user has access
        if (this.cdoc.assign?.length && !this.user.own(this.cdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)) {
            const groups = (await UserModel.listGroup(domainId, this.user._id)).map((g) => g.name);
            const hasAccess = this.cdoc.assign.some((a) => groups.includes(a))
                || (this.cdoc.classes || []).some((c) => groups.includes(c))
                || (this.cdoc.teachers || []).includes(this.user._id);
            if (!hasAccess) {
                throw new NotFoundError('Course', cid.toString());
            }
        }
    }

    @param('cid', Types.ObjectId)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, cid: ObjectId, page = 1) {
        const csdoc = await CourseModel.getStatus(domainId, cid, this.user._id);

        // Get discussions
        const [ddocs, dpcount, dcount] = await this.paginate(
            DiscussionModel.getMulti(domainId, { parentType: TYPE_COURSE, parentId: cid }),
            page,
            'discussion',
        );

        // Get user info
        const uids = [this.cdoc.owner, ...(this.cdoc.maintainer || []), ...(this.cdoc.teachers || [])];
        ddocs.forEach((ddoc) => uids.push(ddoc.owner));
        const udict = await UserModel.getList(domainId, uids);

        // Get enrolled users for sidebar
        let enrolledUsers: number[] = [];
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            enrolledUsers = (await CourseModel.getMultiStatus(domainId, { docId: cid, uid: { $gt: 1 }, attend: 1 })
                .project({ uid: 1 }).limit(100).toArray()).map((x) => +x.uid);
        }
        const enrolledUdict = await UserModel.getListForRender(domainId, enrolledUsers);

        // Get problems
        const pdict = await ProblemModel.getList(domainId, this.cdoc.pids, true, true);

        // Get problem status for current user
        let psdict = {};
        let rdict = {};
        if (csdoc) {
            const valid = (csdoc.journal || []).filter((p) => this.cdoc.pids.includes(p.pid));
            for (const pdetail of valid) {
                psdict[pdetail.pid] = pdetail;
                rdict[pdetail.rid.toString()] = { _id: pdetail.rid };
            }
            if (valid.length) {
                rdict = await RecordModel.getList(domainId, valid.map((pdetail) => pdetail.rid));
            }
        }

        this.response.template = 'course_detail.html';
        this.response.body = {
            cdoc: this.cdoc,
            csdoc,
            udict,
            ddocs,
            page,
            dpcount,
            dcount,
            pdict,
            psdict,
            rdict,
            enrolledUsers,
            enrolledUdict,
            files: sortFiles(this.cdoc.files || []),
        };

        // Replace file:// references
        this.response.body.cdoc.content = this.response.body.cdoc.content
            .replace(/\(file:\/\//g, `(./${cid}/file/`)
            .replace(/="file:\/\//g, `="./${cid}/file/`);
    }

    @param('cid', Types.ObjectId)
    async postAttend(domainId: string, cid: ObjectId) {
        this.checkPerm(PERM.PERM_ATTEND_HOMEWORK);
        if (CourseModel.isDone(this.cdoc)) throw new ValidationError('Course has ended');
        await CourseModel.attend(domainId, cid, this.user._id);
        this.back();
    }
}

// Course Edit Handler
class CourseEditHandler extends Handler {
    cdoc: CourseDoc | null;

    @param('cid', Types.ObjectId, true)
    async prepare(domainId: string, cid?: ObjectId) {
        if (cid) {
            this.cdoc = await CourseModel.get(domainId, cid);
            if (!this.cdoc) throw new CourseNotFoundError(domainId, cid);
            if (!this.user.own(this.cdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
            else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        } else {
            this.checkPerm(PERM.PERM_CREATE_HOMEWORK);
            this.cdoc = null;
        }
    }

    @param('cid', Types.ObjectId, true)
    async get(domainId: string, cid?: ObjectId) {
        const groups = await UserModel.listGroup(domainId);
        this.response.template = 'course_edit.html';
        this.response.body = {
            cdoc: this.cdoc,
            groups,
            page_name: cid ? 'course_edit' : 'course_create',
            pids: this.cdoc ? this.cdoc.pids.join(',') : '',
        };
    }

    @param('cid', Types.ObjectId, true)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('pids', Types.Content, true)
    @param('beginAtDate', Types.Date)
    @param('beginAtTime', Types.Time)
    @param('endAtDate', Types.Date)
    @param('endAtTime', Types.Time)
    @param('maintainer', Types.NumericArray, true)
    @param('teachers', Types.NumericArray, true)
    @param('assign', Types.CommaSeperatedArray, true)
    @param('classes', Types.CommaSeperatedArray, true)
    async postUpdate(
        domainId: string,
        cid: ObjectId | undefined,
        title: string,
        content: string,
        _pids: string = '',
        beginAtDate: string,
        beginAtTime: string,
        endAtDate: string,
        endAtTime: string,
        maintainer: number[] = [],
        teachers: number[] = [],
        assign: string[] = [],
        classes: string[] = [],
    ) {
        const pids = _pids.replace(/，/g, ',').split(',').map((i) => +i).filter((i) => i);
        const beginAt = new Date(`${beginAtDate} ${beginAtTime}`);
        const endAt = new Date(`${endAtDate} ${endAtTime}`);

        if (isNaN(beginAt.getTime())) throw new ValidationError('beginAtDate', 'beginAtTime');
        if (isNaN(endAt.getTime())) throw new ValidationError('endAtDate', 'endAtTime');
        if (beginAt >= endAt) throw new ValidationError('endAtDate', 'endAtTime');

        // Validate problems exist
        if (pids.length) {
            await ProblemModel.getList(domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id, true);
        }

        if (!cid) {
            cid = await CourseModel.add(domainId, title, content, this.user._id, pids, beginAt, endAt, {
                maintainer,
                teachers,
                assign,
                classes,
            });
        } else {
            await CourseModel.edit(domainId, cid, {
                title,
                content,
                pids,
                beginAt,
                endAt,
                maintainer,
                teachers,
                assign,
                classes,
            });
        }

        this.response.body = { cid };
        this.response.redirect = this.url('course_detail', { cid });
    }

    @param('cid', Types.ObjectId)
    async postDelete(domainId: string, cid: ObjectId) {
        if (!this.user.own(this.cdoc!)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        await Promise.all([
            CourseModel.del(domainId, cid),
            StorageModel.del(this.cdoc?.files?.map((i) => `course/${domainId}/${cid}/${i.name}`) || [], this.user._id),
        ]);
        this.response.redirect = this.url('course_main');
    }
}

// Course Files Handler
class CourseFilesHandler extends Handler {
    cdoc: CourseDoc;

    @param('cid', Types.ObjectId)
    async prepare(domainId: string, cid: ObjectId) {
        this.cdoc = await CourseModel.get(domainId, cid);
        if (!this.cdoc) throw new CourseNotFoundError(domainId, cid);
        if (!this.user.own(this.cdoc) && !(this.cdoc.teachers || []).includes(this.user._id)) {
            this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        } else {
            this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        }
    }

    @param('cid', Types.ObjectId)
    async get(domainId: string, cid: ObjectId) {
        this.response.body = {
            cdoc: this.cdoc,
            csdoc: await CourseModel.getStatus(domainId, cid, this.user._id),
            udoc: await UserModel.getById(domainId, this.cdoc.owner),
            files: sortFiles(this.cdoc.files || []),
            urlForFile: (filename: string) => this.url('course_file_download', { cid, filename }),
        };
        this.response.pjax = 'partials/files.html';
        this.response.template = 'course_files.html';
    }

    @param('cid', Types.ObjectId)
    @post('filename', Types.Filename, true)
    async postUploadFile(domainId: string, cid: ObjectId, filename: string) {
        if ((this.cdoc.files?.length || 0) >= SystemModel.get('limit.contest_files')) {
            throw new FileLimitExceededError('count');
        }
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const size = (this.cdoc.files || []).reduce((acc, i) => acc + (i.size || 0), 0) + file.size;
        if (size >= SystemModel.get('limit.contest_files_size')) {
            throw new FileLimitExceededError('size');
        }
        await StorageModel.put(`course/${domainId}/${cid}/${filename}`, file.filepath, this.user._id);
        const meta = await StorageModel.getMeta(`course/${domainId}/${cid}/${filename}`);
        const payload = { _id: filename, name: filename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!meta) throw new FileUploadError();
        await CourseModel.edit(domainId, cid, { files: [...(this.cdoc.files || []), payload] } as any);
        this.back();
    }

    @param('cid', Types.ObjectId)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, cid: ObjectId, files: string[]) {
        await Promise.all([
            StorageModel.del(files.map((t) => `course/${domainId}/${cid}/${t}`), this.user._id),
            CourseModel.edit(domainId, cid, { files: this.cdoc.files?.filter((i) => !files.includes(i.name)) } as any),
        ]);
        this.back();
    }
}

// Course File Download Handler
class CourseFileDownloadHandler extends Handler {
    @param('cid', Types.ObjectId)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean, true)
    async get(domainId: string, cid: ObjectId, filename: string, noDisposition = false) {
        const cdoc = await CourseModel.get(domainId, cid);
        if (!cdoc) throw new CourseNotFoundError(domainId, cid);

        this.response.addHeader('Cache-Control', 'public');
        const target = `course/${domainId}/${cid}/${filename}`;
        this.response.redirect = await StorageModel.signDownloadLink(
            target,
            noDisposition ? undefined : filename,
            false,
            'user',
        );
    }
}

// Course Scoreboard Handler
class CourseScoreboardHandler extends Handler {
    @param('cid', Types.ObjectId)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, cid: ObjectId, page = 1) {
        const cdoc = await CourseModel.get(domainId, cid);
        if (!cdoc) throw new CourseNotFoundError(domainId, cid);

        // Check permission for viewing scoreboard
        this.checkPerm(PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);

        // Get all enrolled users
        const cursor = CourseModel.getMultiStatus(domainId, { docId: cid, attend: 1 });
        const [csdocs, cpcount] = await this.paginate(cursor, page, 'scoreboard');

        const uids = csdocs.map((csdoc) => csdoc.uid);
        const udict = await UserModel.getListForRender(domainId, uids);

        // Get problems
        const pdict = await ProblemModel.getList(domainId, cdoc.pids, true, true);

        // Calculate scores per user
        const rows: any[] = [];
        for (const csdoc of csdocs) {
            const row: any = {
                uid: csdoc.uid,
                user: udict[csdoc.uid],
                scores: {},
                totalScore: 0,
            };
            for (const pid of cdoc.pids) {
                const progress = (csdoc.journal || []).find((j) => j.pid === pid);
                row.scores[pid] = progress?.score || 0;
                row.totalScore += progress?.score || 0;
            }
            rows.push(row);
        }

        // Sort by total score
        rows.sort((a, b) => b.totalScore - a.totalScore);

        this.response.template = 'course_scoreboard.html';
        this.response.body = {
            cdoc,
            pdict,
            rows,
            page,
            cpcount,
        };
    }
}

// Course Records Handler
class CourseRecordsHandler extends Handler {
    @param('cid', Types.ObjectId)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, cid: ObjectId, page = 1) {
        const cdoc = await CourseModel.get(domainId, cid);
        if (!cdoc) throw new CourseNotFoundError(domainId, cid);

        // Get records for problems in this course
        const query: any = {
            pid: { $in: cdoc.pids },
        };

        // Only show own records if user doesn't have permission to view all records
        // Users who can view scoreboard (teachers/admins) can see all students' records
        if (!this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK_SCOREBOARD)) {
            query.uid = this.user._id;
        }

        const cursor = RecordModel.getMulti(domainId, query).sort({ _id: -1 });
        const [rdocs, rpcount] = await this.paginate(cursor, page, 'record');

        // Get user info for all records
        const uids = [...new Set(rdocs.map((r) => r.uid))];
        const udict = await UserModel.getListForRender(domainId, uids);

        // Get problem info
        const pdict = await ProblemModel.getList(domainId, cdoc.pids, true, true);

        this.response.template = 'course_records.html';
        this.response.body = {
            cdoc,
            rdocs,
            pdict,
            udict,
            page,
            rpcount,
        };
    }
}

// Plugin apply function
export async function apply(ctx: Context) {
    // Register routes
    ctx.Route('course_main', '/course', CourseMainHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_create', '/course/create', CourseEditHandler);
    ctx.Route('course_detail', '/course/:cid', CourseDetailHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_edit', '/course/:cid/edit', CourseEditHandler);
    ctx.Route('course_files', '/course/:cid/file', CourseFilesHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_file_download', '/course/:cid/file/:filename', CourseFileDownloadHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_scoreboard', '/course/:cid/scoreboard', CourseScoreboardHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
    ctx.Route('course_records', '/course/:cid/records', CourseRecordsHandler, PERM.PERM_VIEW_HOMEWORK);

    // Inject navigation entry - after training, before contest
    ctx.inject('Nav', 'course_main', { prefix: 'course', before: 'contest_main' }, PERM.PERM_VIEW_HOMEWORK);

    // Add i18n translations
    ctx.i18n.load('zh', {
        course: '课程',
        course_main: '课程',
        course_detail: '课程详情',
        course_create: '创建课程',
        course_edit: '编辑课程',
        course_files: '课程文件',
        course_scoreboard: '成绩表',
        course_records: '提交记录',
        'Create Course': '创建课程',
        'Edit Course': '编辑课程',
        'Course List': '课程列表',
        'Course Detail': '课程详情',
        'Course Files': '课程文件',
        'Course Scoreboard': '成绩表',
        'Course Records': '提交记录',
        'Join Course': '加入课程',
        'Course Introduction': '课程介绍',
        'Course Materials': '课程资料',
        'Enrolled Students': '已加入学生',
        'Problem List': '题目列表',
        'Teachers': '教师',
        'Classes': '班级',
        'Course has ended': '课程已结束',
        'Already enrolled in this course': '已加入该课程',
        'Course not found': '课程未找到',
        'Upload Lecture': '上传讲义',
        'Manage Files': '管理文件',
        'Total Score': '总分',
        'Progress': '进度',
        'Student': '学生',
        'Records': '提交记录',
        'Quick Links': '快速链接',
        'New Discussion': '发起讨论',
        'No discussions yet.': '暂无讨论。',
        'Discussion': '讨论',
        'Submitter': '提交者',
        'Submit Time': '提交时间',
        'No records yet.': '暂无提交记录。',
    });

    ctx.i18n.load('en', {
        course: 'Course',
        course_main: 'Course',
        course_detail: 'Course Detail',
        course_create: 'Create Course',
        course_edit: 'Edit Course',
        course_files: 'Course Files',
        course_scoreboard: 'Scoreboard',
        course_records: 'Records',
        'Create Course': 'Create Course',
        'Edit Course': 'Edit Course',
        'Course List': 'Course List',
        'Course Detail': 'Course Detail',
        'Course Files': 'Course Files',
        'Course Scoreboard': 'Scoreboard',
        'Course Records': 'Records',
        'Join Course': 'Join Course',
        'Course Introduction': 'Course Introduction',
        'Course Materials': 'Course Materials',
        'Enrolled Students': 'Enrolled Students',
        'Problem List': 'Problem List',
        'Teachers': 'Teachers',
        'Classes': 'Classes',
        'Course has ended': 'Course has ended',
        'Already enrolled in this course': 'Already enrolled in this course',
        'Course not found': 'Course not found',
        'Upload Lecture': 'Upload Lecture',
        'Manage Files': 'Manage Files',
        'Total Score': 'Total Score',
        'Progress': 'Progress',
        'Student': 'Student',
        'Records': 'Records',
        'Quick Links': 'Quick Links',
        'New Discussion': 'New Discussion',
        'No discussions yet.': 'No discussions yet.',
        'Discussion': 'Discussion',
        'Submitter': 'Submitter',
        'Submit Time': 'Submit Time',
        'No records yet.': 'No records yet.',
    });

    // Register model globally
    (global as any).Hydro.model.course = CourseModel;
}

export default apply;
